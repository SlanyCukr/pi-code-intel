#!/usr/bin/env -S node --experimental-strip-types
/**
 * Foreign-install integration test.
 *
 * The "Test discipline" rule mandates: "A different install location.
 * If the feature ships dist/, run it from a project where only dist/
 * is reachable — nothing in src/ or scripts/ is."
 *
 * Three rounds of codex review found bugs in this exact category:
 *   - slash command templates referenced relative `dist/...` paths
 *     that resolved into the user's cwd instead of the extension's
 *     install path
 *   - propose-mode fallback path was computed from the analyzed
 *     project's cwd instead of the extension's install path
 *   - parse-session.py wasn't shipped into dist/ so read-session
 *     commands failed
 *
 * Unit tests can't catch these because they run inside this checkout
 * where every path happens to coexist. This test simulates a real
 * deployment by:
 *
 *   1. Running `npm pack` to produce the tarball npm publish would.
 *   2. Extracting the tarball into a tempdir (no node_modules, no
 *      src, only what package.json#files would actually ship).
 *   3. Running the analyzer's CLI from inside that tempdir and
 *      asserting it produces a valid report despite having no
 *      access to the source tree.
 *   4. Repeating with `--propose` to assert the bundled system-
 *      prompt asset is reachable.
 *
 * Runs slow (~10-30s for npm pack + extract + two analyzer runs).
 * NOT in `npm test`. Run via `npm run test:foreign`. CI runs it on
 * push.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function run(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function ok(label: string, msg = "ok"): void {
	console.log(`[foreign] ✓ ${label}: ${msg}`);
}

async function main(): Promise<void> {
	// Produce the artifact npm publish would. Builds dist/, then tars
	// per package.json#files (or the project root if no files field).
	console.log("[foreign] running `npm pack`...");
	const packOutput = run("npm pack --silent --json", REPO_ROOT);
	const packResult = JSON.parse(packOutput) as Array<{ filename: string }>;
	assert.ok(packResult.length === 1, "npm pack should produce exactly one tarball");
	const tarballName = packResult[0]!.filename;
	const tarballPath = join(REPO_ROOT, tarballName);

	const tempRoot = mkdtempSync(join(tmpdir(), "pi-code-intel-foreign-"));
	console.log(`[foreign] tempdir: ${tempRoot}`);

	try {
		// Real `npm install` of the tarball into a fresh project. This
		// is slow (~30-60s) but it's the only way to exercise:
		//   - peerDependency resolution (@mariozechner/pi-coding-agent)
		//   - the package.json#files allowlist (we just learned the hard
		//     way that without `files: ["dist/"]`, dist gets gitignored
		//     out of the tarball)
		//   - main entry point and bin shim resolution
		run("npm init -y", tempRoot);
		console.log("[foreign] running `npm install <tarball>` (slow)...");
		run(
			`npm install --silent --no-audit --no-fund "${tarballPath}" @mariozechner/pi-coding-agent`,
			tempRoot,
		);
		const extractedRoot = join(tempRoot, "node_modules", "pi-code-intel");
		assert.ok(existsSync(extractedRoot), `installed package not at ${extractedRoot}`);

		// What MUST be in the extracted package — these are the
		// boundary assets that have been forgotten in past rounds.
	const expectedAssets = [
			"dist/extension.js",
			"dist/analysis/cli-main.js",
			"dist/scripts/parse-session.py",
			"dist/prompt/system-prompt.source.ts",
			"dist/agents/templates",
			"dist/commands/templates",
			// LICENSE: required by package.json#license:"MIT". codex
			// round 4 spotted that package.json#files referenced LICENSE
			// but no file existed. npm pack silently skips missing files
			// in the allowlist, so the dead reference would have shipped.
			"LICENSE",
		];
		for (const rel of expectedAssets) {
			assert.ok(
				existsSync(join(extractedRoot, rel)),
				`missing from packed tarball: ${rel}`,
			);
		}
		ok("packed assets present", expectedAssets.length + " required paths");

		// Confirm src/ is NOT present — the test is meaningful only if
		// the analyzer truly cannot reach into src.
		assert.ok(
			!existsSync(join(extractedRoot, "src")),
			"src/ should NOT be in the published tarball; pack contents are wrong",
		);
		ok("src/ correctly excluded from package");

		// Run the analyzer from inside the extracted package. Use
		// --cwd pointing at the repo root so it finds real sessions
		// in ~/.pi/agent/sessions. --no-write keeps it stdout-only.
		console.log("[foreign] running analyzer from installed package...");
		const cliPath = join(extractedRoot, "dist", "analysis", "cli-main.js");
		const reportOutput = execSync(
			`node "${cliPath}" --cwd "${REPO_ROOT}" --since 30d --no-write`,
			{ cwd: tempRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		);
		assert.match(reportOutput, /^# Pi session analysis/, "report missing main heading");
		assert.match(reportOutput, /## 1\. Summary/, "report missing Summary section");
		assert.match(reportOutput, /## 2\. Efficiency/, "report missing Efficiency section");
		assert.match(reportOutput, /## 3\. Anti-patterns/, "report missing Anti-patterns section");
		ok("analyzer produced valid report from foreign install", `${reportOutput.length} chars`);

		// Sanity check: the report should NOT mention any path inside
		// REPO_ROOT/src — that would mean we leaked dev-tree assumptions.
		// (We DO mention REPO_ROOT itself because it's the analyzed cwd.)
		const leakedSrcPath = new RegExp(
			REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/src/(?!prompt/system-prompt\\.ts)",
		);
		assert.ok(
			!leakedSrcPath.test(reportOutput),
			"report references analyzed-cwd src/ path — install location leak",
		);
		ok("no dev-tree path leak in report output");

		// NOTE: --propose is intentionally NOT exercised end-to-end here.
		// It calls an LLM, which is slow (~1-3 min) and flaky for an
		// integration test. The boundary it would catch — the bundled
		// system-prompt.source.ts asset being reachable from the install
		// location — is already covered above by the expectedAssets list
		// (asset is in the package) and by the resolveSystemPromptFallback
		// unit test in test/analysis/cli.test.ts (path resolution logic).

		console.log("[foreign] ✓ foreign-install integration test passed");
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
		// Always clean up the tarball npm pack left in the repo root.
		try {
			rmSync(tarballPath, { force: true });
		} catch {
			/* best-effort */
		}
	}
}

main().catch((err) => {
	console.error("[foreign] ✗ foreign-install integration test FAILED:");
	console.error(err);
	process.exit(1);
});
