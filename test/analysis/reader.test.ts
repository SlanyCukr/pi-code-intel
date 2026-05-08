import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSession } from "../../src/analysis/reader.js";

/**
 * Helpers for writing JSONL fixtures into a temp dir. Each test creates
 * its own session file so cases stay isolated.
 */
function jsonl(...entries: object[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function writeSessionFile(dir: string, content: string): string {
	const path = join(dir, "session.jsonl");
	writeFileSync(path, content, "utf-8");
	return path;
}

const HEADER = {
	type: "session",
	version: 3,
	id: "session-uuid-1",
	timestamp: "2026-05-08T10:00:00.000Z",
	cwd: "/some/project",
};

describe("readSession", () => {
	let tmp: string;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-analyze-test-"));
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		consoleErrorSpy.mockRestore();
	});

	it("parses a header and returns it on `header`", () => {
		const path = writeSessionFile(tmp, jsonl(HEADER));
		const result = readSession(path);
		expect(result.header).toMatchObject({
			type: "session",
			id: "session-uuid-1",
			cwd: "/some/project",
			timestamp: "2026-05-08T10:00:00.000Z",
			version: 3,
		});
		expect(result.events).toEqual([]);
		expect(result.filePath).toBe(path);
	});

	it("flattens an assistant message with two parallel toolCall blocks into two events sharing entryId", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-05-08T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Doing two things." },
						{
							type: "toolCall",
							id: "call-A",
							name: "read",
							arguments: { path: "src/foo.ts" },
						},
						{
							type: "toolCall",
							id: "call-B",
							name: "lsp",
							arguments: { action: "definition", file: "src/foo.ts" },
						},
					],
				},
			}),
		);

		const result = readSession(path);

		// One assistant_text event + two tool_call events, all sharing entryId.
		expect(result.events).toHaveLength(3);
		expect(result.events.map((e) => e.kind)).toEqual([
			"assistant_text",
			"tool_call",
			"tool_call",
		]);
		expect(result.events.every((e) => e.entryId === "entry-1")).toBe(true);
		expect(result.events.every((e) => e.lineNumber === 2)).toBe(true);

		const calls = result.events.filter((e) => e.kind === "tool_call");
		expect(calls[0]).toMatchObject({
			toolCallId: "call-A",
			name: "read",
			arguments: { path: "src/foo.ts" },
		});
		expect(calls[1]).toMatchObject({
			toolCallId: "call-B",
			name: "lsp",
		});
	});

	it("emits a tool_result event with flattened text and isError", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "message",
				id: "entry-2",
				parentId: null,
				timestamp: "2026-05-08T10:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-A",
					toolName: "read",
					content: [
						{ type: "text", text: "first chunk\n" },
						{ type: "text", text: "second chunk" },
					],
					isError: false,
				},
			}),
		);

		const result = readSession(path);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({
			kind: "tool_result",
			toolCallId: "call-A",
			toolName: "read",
			isError: false,
			contentText: "first chunk\nsecond chunk",
		});
	});

	it("flattens a user message with string content directly", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "message",
				id: "entry-u1",
				timestamp: "2026-05-08T10:00:03.000Z",
				message: { role: "user", content: "do the thing" },
			}),
		);
		const result = readSession(path);
		expect(result.events).toEqual([
			expect.objectContaining({
				kind: "user_message",
				text: "do the thing",
			}),
		]);
	});

	it("skips malformed JSON lines, counts them, and continues parsing", () => {
		// Deliberately interleave a broken line in the middle.
		const broken = `${JSON.stringify(HEADER)}\nthis is not json\n${JSON.stringify({
			type: "message",
			id: "entry-after-broken",
			timestamp: "2026-05-08T10:00:04.000Z",
			message: { role: "user", content: "hi" },
		})}\n`;
		const path = writeSessionFile(tmp, broken);

		const result = readSession(path);
		expect(result.malformedLines).toBe(1);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].kind).toBe("user_message");
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("skipping malformed JSON"),
		);
	});

	it("skips entries lacking a string `type` field", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, { id: "no-type-here", foo: "bar" }),
		);
		const result = readSession(path);
		expect(result.malformedLines).toBe(1);
		expect(result.events).toHaveLength(0);
	});

	it("tolerates and ignores unknown entry types for forward compatibility", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "future_unknown_type_added_in_pi_v99",
				id: "entry-x",
				timestamp: "2026-05-08T10:00:05.000Z",
				somePayload: 42,
			}),
		);
		const result = readSession(path);
		expect(result.malformedLines).toBe(0); // not malformed, just unrecognized
		expect(result.totalEntries).toBe(1);
		expect(result.events).toHaveLength(0);
	});

	it("ignores model_change, thinking_level_change, label, custom, custom_message, session_info", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(
				HEADER,
				{ type: "model_change", id: "m1", timestamp: "t", provider: "anthropic", modelId: "x" },
				{ type: "thinking_level_change", id: "t1", timestamp: "t", thinkingLevel: "high" },
				{ type: "label", id: "l1", timestamp: "t", targetId: "x", label: "checkpoint" },
				{ type: "custom", id: "c1", timestamp: "t", customType: "ext", data: {} },
				{ type: "custom_message", id: "cm1", timestamp: "t", customType: "ext", content: "x", display: false },
				{ type: "session_info", id: "si1", timestamp: "t", name: "My session" },
			),
		);
		const result = readSession(path);
		expect(result.events).toHaveLength(0);
		expect(result.totalEntries).toBe(6);
	});

	it("surfaces a compaction event with tokensBefore", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "compaction",
				id: "comp-1",
				timestamp: "2026-05-08T10:00:10.000Z",
				summary: "earlier work",
				firstKeptEntryId: "entry-keep",
				tokensBefore: 50000,
			}),
		);
		const result = readSession(path);
		expect(result.events).toEqual([
			expect.objectContaining({
				kind: "compaction",
				entryId: "comp-1",
				tokensBefore: 50000,
			}),
		]);
	});

	it("surfaces a branch_summary event with fromId", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "branch_summary",
				id: "bs-1",
				timestamp: "t",
				fromId: "abandoned-leaf",
				summary: "we tried X",
			}),
		);
		const result = readSession(path);
		expect(result.events).toEqual([
			expect.objectContaining({
				kind: "branch_summary",
				fromId: "abandoned-leaf",
			}),
		]);
	});

	it("throws when no session header is present", () => {
		const path = writeSessionFile(
			tmp,
			jsonl({
				type: "message",
				id: "orphan",
				timestamp: "t",
				message: { role: "user", content: "hi" },
			}),
		);
		expect(() => readSession(path)).toThrow(/no \`type: "session"\` header/);
	});

	it("throws when the file does not exist", () => {
		const missing = join(tmp, "nope.jsonl");
		expect(() => readSession(missing)).toThrow(/Session file not found/);
	});

	it("ignores a duplicate session header on a later line, keeping the first", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(
				HEADER,
				{ ...HEADER, id: "session-uuid-2", cwd: "/different" },
				{
					type: "message",
					id: "m1",
					timestamp: "t",
					message: { role: "user", content: "hi" },
				},
			),
		);
		const result = readSession(path);
		expect(result.header.id).toBe("session-uuid-1");
		expect(result.header.cwd).toBe("/some/project");
		expect(result.events).toHaveLength(1);
	});

	it("preserves file-order line numbers across multiple entries", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(
				HEADER, // line 1
				{
					type: "message",
					id: "m1",
					timestamp: "t",
					message: { role: "user", content: "first" },
				}, // line 2
				{
					type: "message",
					id: "m2",
					timestamp: "t",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
					},
				}, // line 3
			),
		);
		const result = readSession(path);
		expect(result.events.map((e) => e.lineNumber)).toEqual([2, 3]);
	});

	it("flattens a user message whose content is an array of text+image blocks (image discarded)", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "message",
				id: "u1",
				timestamp: "t",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "look at this " },
						{ type: "image", data: "iVBOR…", mimeType: "image/png" },
						{ type: "text", text: "screenshot" },
					],
				},
			}),
		);
		const result = readSession(path);
		expect(result.events[0]).toMatchObject({
			kind: "user_message",
			text: "look at this screenshot",
		});
	});

	it("emits no assistant_text event when the assistant message has only toolCall blocks", () => {
		const path = writeSessionFile(
			tmp,
			jsonl(HEADER, {
				type: "message",
				id: "a1",
				timestamp: "t",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
					],
				},
			}),
		);
		const result = readSession(path);
		expect(result.events.map((e) => e.kind)).toEqual(["tool_call"]);
	});
});
