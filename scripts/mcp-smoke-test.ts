#!/usr/bin/env -S node --experimental-strip-types
/**
 * Context7 MCP smoke test.
 *
 * The "Test discipline" rule in AGENTS.md mandates: "Real binary I/O when
 * the boundary uses one. Stdio framing, file-format parsing, MCP
 * protocols — a mock that parrots the wrong protocol passes its own
 * tests." The original Context7 framing bug (LSP-style Content-Length
 * vs newline-delimited JSON) survived 30+ unit tests because the mocks
 * parroted the wrong protocol. The bug only surfaced when running
 * against a real MCP server.
 *
 * This script spawns the real `npx -y @upstash/context7-mcp@<pinned>`
 * binary, performs the resolve→query round trip end-to-end, and asserts
 * the response shape. Any drift in the wire framing, the tool API
 * surface (parameter renames, removed tools), or the response format
 * fails this test.
 *
 * Usage:
 *   npm run smoke          # builds dist, runs against ./dist/web/context7.js
 *
 * CI runs this on push; if the pinned version drifts in a way the
 * smoke test catches, tighten the pin in src/web/context7.ts.
 *
 * Requires:
 *   - Network (to fetch the npx package and to query the Context7 service)
 *   - npx in PATH
 *
 * Slow: ~30-60s on first run (npx download), ~5-10s when warm.
 */
import assert from "node:assert/strict";
// Imports from dist so the .js extensions resolve correctly. Run after
// `npm run build`. The `npm run smoke` script chains both.
import { Context7Client } from "../dist/web/context7.js";

const TIMEOUT_MS = 120_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	console.log("[smoke] starting Context7 MCP client...");
	const client = new Context7Client();
	const startedAt = Date.now();

	try {
		await withTimeout(client.start(), TIMEOUT_MS, "client.start");
		console.log(`[smoke] client started in ${Date.now() - startedAt}ms`);

		// Step 1: resolve a known library. "react" is a stable choice that
		// has been in the Context7 index since the service launched.
		console.log("[smoke] resolveLibrary('react', 'useState')...");
		const libraryId = await withTimeout(
			client.resolveLibrary("react", "useState"),
			TIMEOUT_MS,
			"resolveLibrary",
		);
		console.log(`[smoke] resolved → ${libraryId}`);
		assert.ok(libraryId, "resolveLibrary returned null/undefined");
		assert.match(
			libraryId,
			/^\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+/,
			`resolved id does not look like /org/project: ${libraryId}`,
		);

		// Step 2: query docs against the resolved id. Tests the second
		// renamed tool (`query-docs`, was `get-library-docs`) and its
		// parameter shape (`libraryId` + `query`).
		console.log(`[smoke] queryDocs('${libraryId}', 'useState')...`);
		const docs = await withTimeout(
			client.queryDocs(libraryId, "useState"),
			TIMEOUT_MS,
			"queryDocs",
		);
		assert.ok(typeof docs === "string", "queryDocs did not return a string");
		assert.ok(
			docs.length > 100,
			`queryDocs response too short (got ${docs.length} chars): ${docs.slice(0, 200)}`,
		);
		console.log(`[smoke] got ${docs.length} chars of docs`);

		// Sanity check: the response should mention the topic we asked
		// about. If Context7 starts returning generic "no results" or
		// some error blob with isError=false, this catches it.
		assert.match(
			docs.toLowerCase(),
			/use\s*state|usestate|hook/,
			"queryDocs response does not mention the queried topic",
		);

		console.log("[smoke] ✓ Context7 MCP smoke test passed");
	} finally {
		client.stop();
	}
}

main().catch((err) => {
	console.error("[smoke] ✗ Context7 MCP smoke test FAILED:");
	console.error(err);
	process.exit(1);
});
