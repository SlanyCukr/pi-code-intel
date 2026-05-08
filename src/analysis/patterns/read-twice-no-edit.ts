import type {
	AntiPatternHit,
	AntiPatternRule,
} from "../types.js";
import { getFilePathArg } from "./util.js";

/**
 * Rule: same file path read more than once with no `edit` or `write` to
 * that path between the reads. Signals over-reading — the agent already
 * had the content; a targeted LSP query or a re-read with offset/limit
 * was probably the right call.
 *
 * The first read is never flagged. Each subsequent read of the same
 * unchanged path produces one hit.
 *
 * Tracking is by exact path-arg string. We do not normalize or resolve
 * relative paths — a session that reads `./src/x.ts` and then `src/x.ts`
 * would not flag, which is acceptable: the rule errs toward not flagging.
 */
export const readTwiceNoEdit: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];

	/**
	 * For each path: the lineNumber of the most recent read whose content
	 * has not been invalidated by a subsequent edit/write. Once we see an
	 * edit/write to the path, the path's mental model is stale and the
	 * next read is legitimate (so we drop the entry).
	 */
	const lastReadLine = new Map<string, number>();

	for (const ev of session.events) {
		if (ev.kind !== "tool_call") continue;
		const path = getFilePathArg(ev);
		if (path === null) continue;

		if (ev.name === "read") {
			const prev = lastReadLine.get(path);
			if (prev !== undefined) {
				hits.push({
					ruleId: "read-twice-no-edit",
					sessionId: session.header.id,
					filePath: session.filePath,
					lineRange: [prev, ev.lineNumber],
					message: `read ${path} again at line ${ev.lineNumber} (last read at ${prev}, no edit/write between)`,
				});
			}
			lastReadLine.set(path, ev.lineNumber);
		} else if (ev.name === "edit" || ev.name === "write") {
			// File mutated — any later read is a legitimate refresh.
			lastReadLine.delete(path);
		}
	}

	return hits;
};
