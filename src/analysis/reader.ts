import { readFileSync, existsSync } from "node:fs";
import { SYSTEM_PROMPT_CUSTOM_TYPE } from "./capture.js";
import type {
	AnalysisEvent,
	AssistantTextEvent,
	BranchSummaryEvent,
	CompactionEvent,
	ParsedSession,
	SessionHeader,
	SystemPromptCapturedEvent,
	ToolCallBlock,
	ToolCallEvent,
	ToolResultEvent,
	UserMessageEvent,
} from "./types.js";

/**
 * Read and parse one session JSONL file into typed events.
 *
 * Strategy:
 * 1. Split the file on `\n`. Each non-empty line is one entry.
 * 2. JSON.parse each line. Malformed lines are skipped with a stderr
 *    warning and counted in `malformedLines`.
 * 3. The first valid entry MUST be a `type: "session"` header — the
 *    pi session format guarantees this. If the first valid entry is
 *    something else we throw, because trying to analyze a file with
 *    no header means we don't know what cwd it belongs to.
 * 4. Subsequent entries are mapped to `AnalysisEvent`s. Entry types we
 *    don't analyze (`label`, `custom`, `model_change`,
 *    `thinking_level_change`, `session_info`, `custom_message`) are
 *    silently skipped — they exist in the file but aren't part of the
 *    analyzer's measurement surface.
 *
 * Sync-only: session files are local and small enough (this repo's
 * largest is ~1.2MB) that streaming buys nothing.
 */
export function readSession(path: string): ParsedSession {
	if (!existsSync(path)) {
		throw new Error(`Session file not found: ${path}`);
	}

	const raw = readFileSync(path, "utf-8");
	const lines = raw.split("\n");
	const events: AnalysisEvent[] = [];
	let header: SessionHeader | null = null;
	let totalEntries = 0;
	let malformedLines = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;

		const lineNumber = i + 1; // 1-based for human-readable references

		// Pi session JSONL is a permissive event format that includes 6+
		// `type` discriminants with mostly disjoint payloads. The reader
		// hand-narrows each branch via `typeof`/`Array.isArray` checks below,
		// so the parsed object is typed `any` here rather than carrying a
		// large precarious union — every field is validated at the use site.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch (err) {
			malformedLines++;
			console.error(
				`[analyze-sessions] ${path}:${lineNumber}: skipping malformed JSON: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			continue;
		}

		const type = entry?.type;
		if (typeof type !== "string") {
			malformedLines++;
			console.error(
				`[analyze-sessions] ${path}:${lineNumber}: skipping entry with no string \`type\` field`,
			);
			continue;
		}

		if (type === "session") {
			if (header !== null) {
				// Multiple session headers in one file is a protocol violation;
				// keep the first and skip subsequent ones.
				console.error(
					`[analyze-sessions] ${path}:${lineNumber}: ignoring duplicate session header`,
				);
				continue;
			}
			header = {
				type: "session",
				version: entry.version,
				id: String(entry.id ?? ""),
				cwd: String(entry.cwd ?? ""),
				timestamp: String(entry.timestamp ?? ""),
				parentSession: entry.parentSession,
			};
			continue;
		}

		// All non-session entries must come AFTER the session header.
		if (header === null) {
			throw new Error(
				`Session file ${path} has no \`type: "session"\` header before line ${lineNumber}`,
			);
		}

		// Header is metadata, not a tree entry; only count real entries here.
		totalEntries++;

		const entryId = String(entry.id ?? "");
		const timestamp = String(entry.timestamp ?? "");

		switch (type) {
			case "message":
				expandMessageEntry(entry, lineNumber, entryId, timestamp, events);
				break;
			case "compaction":
				events.push({
					kind: "compaction",
					entryId,
					lineNumber,
					timestamp,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
				} satisfies CompactionEvent);
				break;
			case "branch_summary":
				events.push({
					kind: "branch_summary",
					entryId,
					lineNumber,
					timestamp,
					fromId: String(entry.fromId ?? ""),
				} satisfies BranchSummaryEvent);
				break;
			case "custom": {
				// Most `custom` entries belong to other extensions and are
				// invisible to the analyzer. The exception is our own
				// `code-intel:system-prompt` entries, which carry the rendered
				// system prompt that was in effect at this point in the session.
				if (entry.customType === SYSTEM_PROMPT_CUSTOM_TYPE) {
					const data = entry.data;
					if (data && typeof data === "object") {
						const text = typeof data.text === "string" ? data.text : "";
						const hash = typeof data.hash === "string" ? data.hash : "";
						const capturedAt =
							typeof data.capturedAt === "string" ? data.capturedAt : timestamp;
						const activeTools = Array.isArray(data.activeTools)
							? data.activeTools.filter((t: unknown): t is string => typeof t === "string")
							: [];
						if (text) {
							events.push({
								kind: "system_prompt_captured",
								entryId,
								lineNumber,
								timestamp,
								text,
								hash,
								capturedAt,
								activeTools,
							} satisfies SystemPromptCapturedEvent);
						}
					}
				}
				break;
			}
			// Types we tolerate but don't surface as analysis events.
			case "model_change":
			case "thinking_level_change":
			case "label":
			case "custom_message":
			case "session_info":
				break;
			default:
				// Unknown type — counted in totalEntries but not surfaced.
				// Don't warn: pi may add new types in future versions and we
				// want forward compatibility, not noise.
				break;
		}
	}

	if (header === null) {
		throw new Error(`Session file ${path} contains no valid \`session\` header`);
	}

	return {
		header,
		events,
		filePath: path,
		totalEntries,
		malformedLines,
	};
}

/**
 * Expand a `type: "message"` entry into one or more analysis events.
 *
 * - `assistant` messages may contain multiple `toolCall` blocks (parallel
 *   calls); each becomes its own `tool_call` event sharing the parent
 *   entryId. Plain `text` blocks become an `assistant_text` event with
 *   the concatenation of all text blocks in that message.
 * - `toolResult` messages become a single `tool_result` event with the
 *   text content flattened.
 * - `user` messages become a `user_message` event.
 * - `bashExecution`, `branchSummary`, `compactionSummary`, and `custom`
 *   roles are tolerated but not surfaced — they don't represent agent
 *   tool use that the analyzer measures.
 */
function expandMessageEntry(
	// Same any-typed entry as the reader's main loop; see the comment there
	// for the rationale. Each branch below validates the fields it consumes.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	entry: any,
	lineNumber: number,
	entryId: string,
	timestamp: string,
	events: AnalysisEvent[],
): void {
	const message = entry.message;
	if (!message || typeof message !== "object") return;

	const role = message.role;
	switch (role) {
		case "assistant": {
			// Preserve content-block order: assistant text usually narrates
			// the tool calls that follow it. Coalesce consecutive text blocks
			// into one assistant_text event; flush at every non-text block.
			const content = Array.isArray(message.content) ? message.content : [];
			let pendingText: string[] = [];
			const flushText = () => {
				if (pendingText.length === 0) return;
				events.push({
					kind: "assistant_text",
					entryId,
					lineNumber,
					timestamp,
					text: pendingText.join(""),
				} satisfies AssistantTextEvent);
				pendingText = [];
			};
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string") {
					pendingText.push(block.text);
				} else if (block.type === "toolCall") {
					flushText();
					const tc = block as ToolCallBlock;
					events.push({
						kind: "tool_call",
						entryId,
						lineNumber,
						timestamp,
						toolCallId: String(tc.id ?? ""),
						name: String(tc.name ?? ""),
						arguments: (tc.arguments ?? {}) as Record<string, unknown>,
					} satisfies ToolCallEvent);
				}
				// `thinking` blocks are intentionally not surfaced.
			}
			flushText();
			break;
		}
		case "user": {
			const text = flattenContentText(message.content);
			events.push({
				kind: "user_message",
				entryId,
				lineNumber,
				timestamp,
				text,
			} satisfies UserMessageEvent);
			break;
		}
		case "toolResult": {
			events.push({
				kind: "tool_result",
				entryId,
				lineNumber,
				timestamp,
				toolCallId: String(message.toolCallId ?? ""),
				toolName: String(message.toolName ?? ""),
				isError: Boolean(message.isError),
				contentText: flattenContentText(message.content),
			} satisfies ToolResultEvent);
			break;
		}
		// Other roles (bashExecution, branchSummary, etc.) are skipped.
	}
}

/**
 * Flatten a message-content field (string OR array of content blocks)
 * into plain text. Image blocks contribute nothing.
 */
function flattenContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
		if (block && typeof block === "object" && block.type === "text") {
			const t = block.text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("");
}
