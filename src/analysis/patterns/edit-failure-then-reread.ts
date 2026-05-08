import type {
	AntiPatternHit,
	AntiPatternRule,
	ToolCallEvent,
} from "../types.js";
import { getFilePathArg, indexToolResults } from "./util.js";

/**
 * Rule: an `edit` tool call that fails (toolResult isError === true)
 * followed by a `read` of the SAME file before any further edit
 * attempt. Classic stale-file-error pattern: the agent's mental model
 * of the file is out of sync, the edit's `oldText` doesn't match, and
 * the agent has to re-read to reconcile.
 *
 * The fix in the system prompt is "always read before edit". When this
 * rule fires repeatedly, it means the discipline isn't being followed,
 * usually because something OTHER than the agent (a previous edit, a
 * formatter on save, an external tool) changed the file between the
 * read and the edit. The pattern is signal that the "always read" rule
 * needs strengthening or that another tool is mutating files silently.
 *
 * The rule fires once per failed-edit / reread pair.
 */
export const editFailureThenReread: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];
	const results = indexToolResults(session.events);

	for (let i = 0; i < session.events.length; i++) {
		const ev = session.events[i];
		if (ev.kind !== "tool_call" || ev.name !== "edit") continue;
		const editPath = getFilePathArg(ev);
		if (!editPath) continue;

		const result = results.get(ev.toolCallId);
		if (!result || !result.isError) continue;

		// Look forward for the next read or edit on this same path.
		const nextActionable = findNextEditOrReadOfPath(session.events, i + 1, editPath);
		if (nextActionable && nextActionable.name === "read") {
			hits.push({
				ruleId: "edit-failure-then-reread",
				sessionId: session.header.id,
				filePath: session.filePath,
				lineRange: [ev.lineNumber, nextActionable.lineNumber],
				message: `edit ${editPath} failed (line ${ev.lineNumber}) then re-read at line ${nextActionable.lineNumber} — stale-file pattern`,
			});
		}
	}

	return hits;
};

/**
 * Walk forward from `start` and return the first tool_call that is
 * either an `edit` OR a `read` of `path`. Returns null if none.
 */
function findNextEditOrReadOfPath(
	events: ReturnType<() => any[]>,
	start: number,
	path: string,
): ToolCallEvent | null {
	for (let j = start; j < events.length; j++) {
		const ev = events[j];
		if (ev.kind !== "tool_call") continue;
		if (ev.name !== "edit" && ev.name !== "read") continue;
		if (getFilePathArg(ev) !== path) continue;
		return ev as ToolCallEvent;
	}
	return null;
}
