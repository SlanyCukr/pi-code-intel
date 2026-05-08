import type {
	AntiPatternHit,
	AntiPatternRule,
} from "../types.js";
import { getFilePathArg } from "./util.js";

/**
 * Rule: `lsp.document_symbols(F)` immediately followed by `read(F)`
 * within K following tool calls. Signals the agent got the symbol map
 * and then read the whole file anyway — usually `definition` or a
 * targeted read with offset/limit was the intended next step.
 *
 * Heuristic limits we accept:
 * - "Within K tool calls": K = 5. Beyond that, the read may be
 *   legitimately driven by a different question.
 * - "Whole-file read": flagged when the read tool call has no `limit`
 *   argument (or `limit > 200`). A read with a small limit and an
 *   offset is usually a targeted follow-up, which is fine.
 *
 * The rule fires once per (document_symbols, read) pair. Subsequent
 * reads of the same file after the first do not re-flag — that is what
 * `read-twice-no-edit` would catch.
 */
const LOOKAHEAD = 5;
const WHOLE_FILE_LIMIT_THRESHOLD = 200;

export const readAfterDocumentSymbols: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];

	for (let i = 0; i < session.events.length; i++) {
		const ev = session.events[i];
		if (ev.kind !== "tool_call" || ev.name !== "lsp") continue;
		if (ev.arguments?.action !== "document_symbols") continue;

		const targetFile = ev.arguments?.file;
		if (typeof targetFile !== "string" || !targetFile) continue;

		// Look ahead through the next LOOKAHEAD tool_call events.
		let toolCallsSeen = 0;
		for (let j = i + 1; j < session.events.length && toolCallsSeen < LOOKAHEAD; j++) {
			const next = session.events[j];
			if (next.kind !== "tool_call") continue;
			toolCallsSeen++;
			if (next.name !== "read") continue;

			const readPath = getFilePathArg(next);
			if (readPath !== targetFile) continue;

			if (!isWholeFileRead(next.arguments)) {
				// targeted read after document_symbols is the right move; stop looking.
				break;
			}

			hits.push({
				ruleId: "read-after-document-symbols",
				sessionId: session.header.id,
				filePath: session.filePath,
				lineRange: [ev.lineNumber, next.lineNumber],
				message: `lsp.document_symbols(${targetFile}) followed by whole-file read at line ${next.lineNumber} (consider definition / targeted read)`,
			});
			break; // one hit per document_symbols call
		}
	}

	return hits;
};

/**
 * A read is "whole-file" when it has no limit, or limit exceeds the
 * threshold. The `offset` field doesn't affect this — `read(F, offset:
 * 200, limit: 1000)` is still effectively a whole-file dump from a
 * different starting line.
 */
function isWholeFileRead(args: Record<string, unknown> | undefined): boolean {
	const limit = args?.limit;
	if (limit === undefined || limit === null) return true;
	if (typeof limit !== "number") return true; // can't reason — treat as whole
	return limit > WHOLE_FILE_LIMIT_THRESHOLD;
}
