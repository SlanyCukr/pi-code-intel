import type { AnalysisEvent, ToolCallEvent, ToolResultEvent } from "../types.js";

/**
 * Shared helpers for anti-pattern rules. Kept small and pure.
 */

/**
 * Extract the `path` argument from a tool_call event for tools that
 * operate on a file path (read, edit, write). Returns null if the
 * argument is absent or not a string.
 */
export function getFilePathArg(ev: ToolCallEvent): string | null {
	const p = ev.arguments?.path;
	return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Extract the `command` argument from a bash tool_call event.
 */
export function getBashCommand(ev: ToolCallEvent): string | null {
	const c = ev.arguments?.command;
	return typeof c === "string" && c.length > 0 ? c : null;
}

/**
 * Pair tool_call events with their corresponding tool_result events
 * via toolCallId. Returns a Map keyed by toolCallId for O(1) lookup.
 *
 * Tool calls without a matching result (e.g. session aborted before
 * the tool finished) are absent from the map. Tool results without a
 * matching call (rare; would indicate a malformed session) are also
 * absent — callers iterating tool_calls won't see them.
 */
export function indexToolResults(
	events: AnalysisEvent[],
): Map<string, ToolResultEvent> {
	const map = new Map<string, ToolResultEvent>();
	for (const ev of events) {
		if (ev.kind === "tool_result") map.set(ev.toolCallId, ev);
	}
	return map;
}

/**
 * Iterate ONLY tool_call events, in file order, with their original
 * file-order index attached. Useful for state machines that want to
 * reason about adjacency (next/previous) without having to skip past
 * non-tool-call events.
 */
export function* iterToolCalls(
	events: AnalysisEvent[],
): Generator<{ ev: ToolCallEvent; index: number }> {
	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (ev.kind === "tool_call") yield { ev, index: i };
	}
}
