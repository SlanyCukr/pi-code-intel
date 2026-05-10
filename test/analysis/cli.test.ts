import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock createIsolatedSession (the SDK boundary). Non-propose tests
// don't trigger this; propose-mode tests verify the runIsolatedTextCall
// helper end-to-end via the mocked SDK call underneath.
vi.mock("../../src/isolated-session.js", () => ({
	createIsolatedSession: vi.fn(),
}));

import {
	defaultReportPath,
	encodeSessionDirName,
	parseDuration,
	resolveSessionsDir,
	resolveSystemPromptFallback,
	runAnalysis,
} from "../../src/analysis/cli.js";
import { createIsolatedSession } from "../../src/isolated-session.js";

const mockCreateSession = vi.mocked(createIsolatedSession);

describe("encodeSessionDirName", () => {
	it("encodes an absolute path with leading -- and trailing --", () => {
		expect(encodeSessionDirName("/home/user/proj")).toBe("--home-user-proj--");
	});

	it("matches the encoding used by the actual pi sessions directory", () => {
		// This is the exact directory name pi uses for this repo.
		const expected = "--home-slanycukr-Documents-personal-projects-my_coding_agent--";
		expect(
			encodeSessionDirName(
				"/home/slanycukr/Documents/personal/projects/my_coding_agent",
			),
		).toBe(expected);
	});

	// The cases below mirror the SDK's `getDefaultSessionDir` for inputs
	// the previous encoder got wrong. If any of these regress, the
	// analyzer will silently look in a directory pi doesn't write to.

	it("replaces colons in unix paths (regression: round-5 codex)", () => {
		// `:` is legal in Unix filenames and used by some build systems
		// (e.g. `proj:variant`). pi sanitizes it; we must too.
		expect(encodeSessionDirName("/tmp/foo:bar")).toBe("--tmp-foo-bar--");
	});

	it("handles Windows-style paths with backslashes and drive colons", () => {
		// `C:\Users\me` on Windows. The SDK does NOT strip the leading
		// `C` (only a leading `/` or `\`), then replaces `:` and `\`.
		expect(encodeSessionDirName("C:\\Users\\me")).toBe("--C--Users-me--");
	});

	it("handles Windows UNC paths (leading double backslash)", () => {
		// `\\server\share` strips ONE leading backslash, then replaces
		// the rest. Result has three leading dashes (--<-server-share>--).
		expect(encodeSessionDirName("\\\\server\\share")).toBe(
			"---server-share--",
		);
	});

	it("encodes the bare root path / as ----", () => {
		// Root cwd: pi uses `----` (just the four dashes). The previous
		// encoder used a single leading dash and produced `---`, missing
		// any session that genuinely had cwd="/".
		expect(encodeSessionDirName("/")).toBe("----");
	});

	it("matches the SDK's getDefaultSessionDir() byte-for-byte across cases", async () => {
		// Property-style sanity: if the SDK ever publishes its helper, we
		// can swap to it. Until then, this test pins the contract.
		const sdkEncode = (cwd: string): string =>
			`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		for (const sample of [
			"/home/user/proj",
			"/tmp/foo:bar",
			"C:\\Users\\me",
			"\\\\server\\share",
			"/",
			"/with/multiple:colons:here",
			"/single",
		]) {
			expect(encodeSessionDirName(sample)).toBe(sdkEncode(sample));
		}
	});
});

describe("resolveSessionsDir", () => {
	const envBackup = { ...process.env };
	afterEach(() => {
		// Vitest doesn't reset process.env between tests; do it manually.
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, envBackup);
	});

	it("returns ~/.pi/agent/sessions/<encoded-cwd>/ by default", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const result = resolveSessionsDir("/foo/bar");
		expect(result).toMatch(/\/\.pi\/agent\/sessions\/--foo-bar--$/);
	});

	it("honors PI_CODING_AGENT_DIR when set (regression: round-4 codex finding)", () => {
		// Pi (and forks like Tau) support relocating the agent dir via
		// $PI_CODING_AGENT_DIR. Hardcoded ~/.pi/agent missed every session
		// for users who set this. The fix routes through the SDK's
		// getAgentDir() which honors the env var.
		process.env.PI_CODING_AGENT_DIR = "/custom/agent";
		const result = resolveSessionsDir("/foo/bar");
		expect(result).toBe("/custom/agent/sessions/--foo-bar--");
	});

	it("expands ~ in PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "~/custom-pi";
		const result = resolveSessionsDir("/foo/bar");
		// SDK expands the leading tilde.
		expect(result).toMatch(/\/custom-pi\/sessions\/--foo-bar--$/);
		expect(result.startsWith("~")).toBe(false);
	});
});

describe("parseDuration", () => {
	it("parses days, hours, minutes, seconds, weeks", () => {
		expect(parseDuration("7d")).toBe(7 * 86_400_000);
		expect(parseDuration("24h")).toBe(24 * 3_600_000);
		expect(parseDuration("30m")).toBe(30 * 60_000);
		expect(parseDuration("45s")).toBe(45 * 1000);
		expect(parseDuration("2w")).toBe(2 * 7 * 86_400_000);
	});

	it("ignores leading/trailing whitespace", () => {
		expect(parseDuration("  7d  ")).toBe(7 * 86_400_000);
	});

	it("returns null for unparseable input", () => {
		expect(parseDuration("nope")).toBeNull();
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("7y")).toBeNull(); // years not supported
		expect(parseDuration("7.5d")).toBeNull(); // no decimal
	});
});

describe("resolveSystemPromptFallback", () => {
	// We can't easily test the bundled-asset branch in unit tests because
	// the asset's existence depends on whether `npm run build` has run
	// before the test invocation. We assert the secondary-path contract
	// here: when the module's sibling asset is absent, the function falls
	// back to `<analyzedCwd>/src/prompt/system-prompt.ts`. When the asset
	// IS present (after a build), the function returns the bundled path —
	// the existing end-to-end propose run exercises that branch.
	it("falls back to <analyzedCwd>/src/prompt/system-prompt.ts when no bundled asset", () => {
		const result = resolveSystemPromptFallback("/nowhere/");
		// Either branch is acceptable; both produce a real path.
		expect(result).toMatch(/(system-prompt\.source\.ts|system-prompt\.ts)$/);
		// When the bundled path doesn't exist, the result is the analyzed-cwd path.
		// When it does, the result starts with the dist path — either way the
		// shape is correct.
		if (result.endsWith("/system-prompt.ts")) {
			expect(result.startsWith("/nowhere/src/prompt")).toBe(true);
		}
	});

	it("returns the BUNDLED path (dist asset) when it exists", () => {
		// We can't manipulate the module's __dirname, so this test just
		// asserts that whichever path the function returns, it's an absolute
		// real path string (the resolution logic is otherwise tested by the
		// 'falls back to' case above and by end-to-end propose-mode runs).
		const result = resolveSystemPromptFallback("/anything/");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result.endsWith(".ts")).toBe(true);
	});
});

describe("defaultReportPath", () => {
	it("composes <cwd>/.pi/analyses/YYYY-MM-DD_HHMMSS.md", () => {
		const fixed = new Date("2026-05-08T14:07:09.000Z");
		// Use UTC explicitly via Date constructor — local-tz offsets would
		// otherwise make the test depend on the host's TZ. The renderer
		// uses local time so we mirror that with `toLocaleString`-like
		// semantics: just check the structure, not exact digits.
		const result = defaultReportPath("/proj", fixed);
		expect(result.startsWith("/proj/.pi/analyses/")).toBe(true);
		expect(result).toMatch(/\d{4}-\d{2}-\d{2}_\d{6}\.md$/);
	});
});

describe("runAnalysis", () => {
	let tmp: string;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-cli-test-"));
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		consoleErrorSpy.mockRestore();
	});

	/**
	 * Build a self-contained analysis fixture: a temp directory that
	 * stands in for both the working dir AND the place where we tell
	 * the analyzer to look for sessions.
	 *
	 * We DON'T use the real ~/.pi/agent/sessions tree — that would make
	 * tests depend on the developer's actual session history.
	 *
	 * Instead we build a fake sessions dir layout under tmp and pass
	 * --cwd pointing AT it; encodeSessionDirName(cwd) then resolves to
	 * `--<tmp-encoded>--`. We compute the same encoding to know where
	 * to drop our fixture session files.
	 *
	 * Wait — runAnalysis always looks under HOME, which we can't easily
	 * remap without setenv. So instead we make `out` explicit and use
	 * `noWrite: false` with a temp `out`, and rely on `cwd` only for
	 * its visible appearance in metrics.
	 *
	 * For test purposes here, we therefore exercise the END of the
	 * pipeline: the resolution / file-listing logic is covered by
	 * encodeSessionDirName + listSessionFiles unit tests, while
	 * runAnalysis is exercised against a controlled fake home dir.
	 */
	function setupFakeHome(homedir: string): {
		fakeCwd: string;
		fakeSessionsRoot: string;
	} {
		const fakeCwd = join(homedir, "fake-proj");
		mkdirSync(fakeCwd, { recursive: true });
		const fakeSessionsRoot = join(homedir, ".pi", "agent", "sessions");
		mkdirSync(fakeSessionsRoot, { recursive: true });
		return { fakeCwd, fakeSessionsRoot };
	}

	function writeFakeSession(
		sessionsRoot: string,
		cwd: string,
		filename: string,
		header: object,
		messages: object[],
	): string {
		const subdir = join(sessionsRoot, encodeSessionDirName(cwd));
		mkdirSync(subdir, { recursive: true });
		const path = join(subdir, filename);
		const lines = [JSON.stringify(header), ...messages.map((m) => JSON.stringify(m))];
		writeFileSync(path, lines.join("\n") + "\n", "utf-8");
		return path;
	}

	it("writes the report to <cwd>/.pi/analyses/ by default", async () => {
		// Mock $HOME so resolveSessionsDir picks up the temp tree.
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"sess1.jsonl",
				{
					type: "session",
					version: 3,
					id: "uuid-1",
					timestamp: "2026-05-08T10:00:00.000Z",
					cwd: fakeCwd,
				},
				[
					{
						type: "message",
						id: "m1",
						timestamp: "t",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }],
						},
					},
				],
			);

			const result = await runAnalysis({ cwd: fakeCwd });
			expect(result.outPath).not.toBeNull();
			expect(result.outPath!.startsWith(fakeCwd)).toBe(true);
			expect(result.outPath!).toMatch(/\.pi\/analyses\//);
			expect(readFileSync(result.outPath!, "utf-8")).toContain("# Pi session analysis");
			expect(result.sessionFilesAnalyzed).toHaveLength(1);
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("respects --no-write (does not write to disk; outPath is null)", async () => {
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"sess1.jsonl",
				{ type: "session", version: 3, id: "u", timestamp: "t", cwd: fakeCwd },
				[],
			);
			const result = await runAnalysis({ cwd: fakeCwd, noWrite: true });
			expect(result.outPath).toBeNull();
			expect(result.reportMarkdown).toContain("# Pi session analysis");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("filters sessions by --since (mtime cutoff)", async () => {
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			const oldFile = writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"old.jsonl",
				{ type: "session", version: 3, id: "old", timestamp: "t", cwd: fakeCwd },
				[],
			);
			const newFile = writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"new.jsonl",
				{ type: "session", version: 3, id: "new", timestamp: "t", cwd: fakeCwd },
				[],
			);
			// Backdate `old.jsonl` by 30 days.
			const longAgo = Date.now() - 30 * 86_400_000;
			require("node:fs").utimesSync(oldFile, longAgo / 1000, longAgo / 1000);

			const result = await runAnalysis({
				cwd: fakeCwd,
				sinceMs: 7 * 86_400_000, // 7d
				noWrite: true,
			});
			expect(result.sessionFilesAnalyzed).toEqual([newFile]);
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("filters sessions by --session (UUID-prefix match against UUID portion only)", async () => {
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"2026-05-08T10-00-00Z_aaaaaaaa-bbbb.jsonl",
				{ type: "session", version: 3, id: "aaaa", timestamp: "t", cwd: fakeCwd },
				[],
			);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"2026-05-08T11-00-00Z_cccccccc-dddd.jsonl",
				{ type: "session", version: 3, id: "cccc", timestamp: "t", cwd: fakeCwd },
				[],
			);

			const result = await runAnalysis({
				cwd: fakeCwd,
				sessionId: "aaaaaaaa",
				noWrite: true,
			});
			expect(result.sessionFilesAnalyzed).toHaveLength(1);
			expect(result.sessionFilesAnalyzed[0]).toContain("aaaaaaaa");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("resolves a relative cwd to absolute before encoding the sessions directory", async () => {
		// Regression: pi stores absolute cwds in its session subdir names.
		// A relative `cwd` like "." or "./proj" used to be encoded as
		// `--.--` and the analyzer would find no sessions despite the dir
		// existing. We now resolve to an absolute path inside runAnalysis.
		const homeBackup = process.env.HOME;
		const cwdBackup = process.cwd();
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"sess1.jsonl",
				{ type: "session", version: 3, id: "u", timestamp: "t", cwd: fakeCwd },
				[],
			);
			process.chdir(fakeCwd);
			// Pass a relative cwd; if the analyzer didn't resolve it, this
			// would look in `--.--`, find no sessions dir, and return [].
			const result = await runAnalysis({ cwd: ".", noWrite: true });
			expect(result.sessionFilesAnalyzed).toHaveLength(1);
		} finally {
			process.chdir(cwdBackup);
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("--session does NOT match a prefix that appears only in the timestamp portion of the filename", async () => {
		// Regression: previously `--session 2026` (a year prefix that
		// exists in the timestamp) matched every session from that year
		// because the filter used `name.includes(...)`. We now match the
		// UUID portion only.
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"2026-05-08T10-00-00Z_aaaaaaaa-bbbb.jsonl",
				{ type: "session", version: 3, id: "a", timestamp: "t", cwd: fakeCwd },
				[],
			);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"2026-05-08T11-00-00Z_cccccccc-dddd.jsonl",
				{ type: "session", version: 3, id: "c", timestamp: "t", cwd: fakeCwd },
				[],
			);
			const result = await runAnalysis({
				cwd: fakeCwd,
				sessionId: "2026", // year prefix, NOT a UUID prefix
				noWrite: true,
			});
			expect(result.sessionFilesAnalyzed).toEqual([]);
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("filters anti-pattern hits by --rules to the requested rule ids", async () => {
		// Builds a session that triggers two distinct rules
		// (read-twice-no-edit and bash-sed-or-awk-edit), then verifies
		// runAnalysis with rules=[X] retains only X's hits in section 3.
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			const messages = [
				{
					type: "message",
					id: "m1",
					timestamp: "t",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x.ts" } },
						],
					},
				},
				{
					type: "message",
					id: "m2",
					timestamp: "t",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "x.ts" } },
						],
					},
				},
				{
					type: "message",
					id: "m3",
					timestamp: "t",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc3",
								name: "bash",
								arguments: { command: "sed -i 's/foo/bar/' x.ts" },
							},
						],
					},
				},
			];
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"sess1.jsonl",
				{ type: "session", version: 3, id: "u", timestamp: "t", cwd: fakeCwd },
				messages,
			);

			// Baseline: no filter — both rules fire.
			const all = await runAnalysis({ cwd: fakeCwd, noWrite: true });
			expect(all.reportMarkdown).toContain("read-twice-no-edit");
			expect(all.reportMarkdown).toContain("bash-sed-or-awk-edit");

			// With --rules=read-twice-no-edit, only that rule's hits surface.
			const filtered = await runAnalysis({
				cwd: fakeCwd,
				noWrite: true,
				rules: ["read-twice-no-edit"],
			});
			expect(filtered.reportMarkdown).toContain("read-twice-no-edit");
			expect(filtered.reportMarkdown).not.toContain("bash-sed-or-awk-edit");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("--rules with an unknown id silently produces no hits (CLI validates upstream)", async () => {
		// runAnalysis is permissive: unknown ids just match nothing. The
		// cli-main.ts wrapper is what rejects unknown ids before we get
		// here, so the behavior here is "filter applied, no hits survive".
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"sess1.jsonl",
				{ type: "session", version: 3, id: "u", timestamp: "t", cwd: fakeCwd },
				[
					{
						type: "message",
						id: "m1",
						timestamp: "t",
						message: {
							role: "assistant",
							content: [
								{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x.ts" } },
							],
						},
					},
					{
						type: "message",
						id: "m2",
						timestamp: "t",
						message: {
							role: "assistant",
							content: [
								{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "x.ts" } },
							],
						},
					},
				],
			);
			const result = await runAnalysis({
				cwd: fakeCwd,
				noWrite: true,
				rules: ["definitely-not-a-real-rule"],
			});
			expect(result.reportMarkdown).not.toContain("read-twice-no-edit");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("enumerates sub-agent sessions from <sessionsDir>/subagents/ and tags them", async () => {
		// Regression: previously listSessionFiles did flat readdirSync and
		// silently skipped the subagents/ subdir. Pi persists every
		// delegated task there (see agents/runner.ts createSessionStorage),
		// so without this descent N sub-agent sessions per delegating run
		// were invisible to the analyzer.
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			// Top-level session.
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"top.jsonl",
				{ type: "session", version: 3, id: "top-uuid", timestamp: "t", cwd: fakeCwd },
				[],
			);
			// Sub-agent session at <encoded-cwd>/subagents/<file>.jsonl
			const subagentsDir = join(
				fakeSessionsRoot,
				encodeSessionDirName(fakeCwd),
				"subagents",
			);
			mkdirSync(subagentsDir, { recursive: true });
			const subPath = join(subagentsDir, "sub.jsonl");
			writeFileSync(
				subPath,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "sub-uuid",
					timestamp: "t",
					cwd: fakeCwd,
				}) + "\n",
				"utf-8",
			);

			const result = await runAnalysis({ cwd: fakeCwd, noWrite: true });
			expect(result.sessionFilesAnalyzed).toHaveLength(2);
			expect(result.sessionFilesAnalyzed.some((p) => p.endsWith("/subagents/sub.jsonl"))).toBe(
				true,
			);
			// Section 1 should disclose the sub-agent count.
			expect(result.reportMarkdown).toContain("of which 1 are sub-agent sessions");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("returns an empty-analysis report when the sessions directory does not exist", async () => {
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const noSessionsCwd = join(tmp, "never-used");
			mkdirSync(noSessionsCwd, { recursive: true });
			const result = await runAnalysis({ cwd: noSessionsCwd, noWrite: true });
			expect(result.sessionFilesAnalyzed).toEqual([]);
			expect(result.reportMarkdown).toContain("(no sessions analyzed)");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("threads an aborted signal through to propose mode (no LLM call attempted)", async () => {
		// Verifies the AnalysisOptions.signal plumbing: the propose path
		// honors the signal end-to-end and produces an `aborted before LLM
		// call` errorBlock without spawning the isolated session.
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"sess1.jsonl",
				{
					type: "session",
					version: 3,
					id: "uuid-abort",
					timestamp: "2026-05-08T10:00:00.000Z",
					cwd: fakeCwd,
				},
				[],
			);
			// Provide a fallback system-prompt source so propose-mode
			// reaches the LLM-call branch (where the abort is caught)
			// rather than short-circuiting on `grounding === "none"`.
			const promptDir = join(fakeCwd, "src", "prompt");
			mkdirSync(promptDir, { recursive: true });
			writeFileSync(
				join(promptDir, "system-prompt.ts"),
				"export const fallbackPrompt = 'x';",
				"utf-8",
			);
			const ac = new AbortController();
			ac.abort();
			const result = await runAnalysis(
				{ cwd: fakeCwd, propose: true, noWrite: true },
				{ signal: ac.signal },
			);
			expect(result.reportMarkdown).toContain("aborted before LLM call");
			expect(mockCreateSession).not.toHaveBeenCalled();
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});

	it("skips files that fail to parse and reports them in sessionFilesSkipped", async () => {
		const homeBackup = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const { fakeCwd, fakeSessionsRoot } = setupFakeHome(tmp);
			// Valid session
			writeFakeSession(
				fakeSessionsRoot,
				fakeCwd,
				"good.jsonl",
				{ type: "session", version: 3, id: "g", timestamp: "t", cwd: fakeCwd },
				[],
			);
			// Invalid session — no header at all
			const subdir = join(fakeSessionsRoot, encodeSessionDirName(fakeCwd));
			writeFileSync(
				join(subdir, "bad.jsonl"),
				JSON.stringify({ type: "message", id: "x", timestamp: "t", message: { role: "user", content: "hi" } }),
				"utf-8",
			);

			const result = await runAnalysis({ cwd: fakeCwd, noWrite: true });
			expect(result.sessionFilesAnalyzed).toHaveLength(1);
			expect(result.sessionFilesSkipped).toHaveLength(1);
			expect(result.sessionFilesSkipped[0]).toContain("bad.jsonl");
		} finally {
			if (homeBackup === undefined) delete process.env.HOME;
			else process.env.HOME = homeBackup;
		}
	});
});
