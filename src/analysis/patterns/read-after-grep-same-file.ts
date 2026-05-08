import type {
	AntiPatternHit,
	AntiPatternRule,
} from "../types.js";
import { getBashCommand, getFilePathArg } from "./util.js";

/**
 * Rule: bash grep returning matches in file F, immediately followed by
 * `read(F)`. Signals one LSP call (definition / references /
 * document_symbols) would have answered the original question without
 * the intermediate grep + read round-trip.
 *
 * Detection strategy:
 * 1. The grep invocation must be a search-binary command (rg, grep, etc.)
 *    with a file path explicitly named in its arguments. We don't try
 *    to parse grep's output to discover matched files — that's brittle
 *    and the result content isn't always a clean file:line:match.
 * 2. The file path is the LAST positional argument that looks like a
 *    file path (contains `/` or ends in a common code extension).
 * 3. The next tool_call within K events that reads any file mentioned
 *    in the grep command produces a hit.
 *
 * Conservative: a grep over a directory (`rg foo src/`) won't have a
 * single named file and won't flag. A grep that matched a file but
 * doesn't name it (impossible — grep needs a path or stdin) likewise
 * won't flag. False negatives are fine.
 */
const LOOKAHEAD = 3;
const FILE_EXT_HINT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|rb|md|json|yaml|yml|toml)$/i;

export const readAfterGrepSameFile: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];

	for (let i = 0; i < session.events.length; i++) {
		const ev = session.events[i];
		if (ev.kind !== "tool_call" || ev.name !== "bash") continue;
		const cmd = getBashCommand(ev);
		if (!cmd) continue;

		const targetFiles = extractGrepTargetFiles(cmd);
		if (targetFiles.length === 0) continue;

		let toolCallsSeen = 0;
		for (let j = i + 1; j < session.events.length && toolCallsSeen < LOOKAHEAD; j++) {
			const next = session.events[j];
			if (next.kind !== "tool_call") continue;
			toolCallsSeen++;
			if (next.name !== "read") continue;
			const readPath = getFilePathArg(next);
			if (!readPath) continue;
			if (!targetFiles.some((f) => f === readPath || readPath.endsWith(f))) continue;

			hits.push({
				ruleId: "read-after-grep-same-file",
				sessionId: session.header.id,
				filePath: session.filePath,
				lineRange: [ev.lineNumber, next.lineNumber],
				message: `grep on ${readPath} (line ${ev.lineNumber}) followed by read of same file (line ${next.lineNumber}) — consider one lsp call`,
			});
			break;
		}
	}

	return hits;
};

/**
 * Extract candidate file paths from a grep-family command line. Returns
 * empty array if the command is not a recognized search binary or has
 * no file-like argument.
 */
export function extractGrepTargetFiles(command: string): string[] {
	const trimmed = command.trim();
	if (!trimmed) return [];
	const stage = trimmed.split(/[|;&]/)[0].trim();
	const tokens = stage.split(/\s+/);
	if (tokens.length < 2) return [];

	const SEARCH_BINARIES = new Set(["grep", "rg", "ack", "ag", "fgrep", "egrep"]);
	if (!SEARCH_BINARIES.has(tokens[0])) return [];

	const files: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("-")) continue; // skip flags (no attempt to skip flag-args; OK as heuristic)
		// First non-flag token is typically the pattern; subsequent ones
		// are paths. We treat any token containing `/` or ending in a
		// known extension as a file path.
		if (t.includes("/") || FILE_EXT_HINT.test(t)) {
			// Strip surrounding quotes.
			let s = t;
			if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
				s = s.slice(1, -1);
			}
			files.push(s);
		}
	}
	return files;
}
