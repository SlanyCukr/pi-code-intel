import type { AntiPatternHit, AntiPatternRule } from "../types.js";
import { getBashCommand } from "./util.js";

/**
 * Rule: bash invocation that dumps a file to stdout via `cat`, `head`,
 * `tail`, `less`, `more`, or `bat`. The system prompt's BASH_ROUTING
 * block prohibits this in favor of the `read` tool — read returns
 * structured content, while bash dumps waste tokens on shell formatting
 * and do not benefit from the file-state tracking that `read` enables
 * (which `edit` then relies on for stale-file detection).
 *
 * Detection scope: only "the agent wants to see the file" intent.
 * Cases we deliberately do NOT flag:
 * - Piped commands (`cat foo | grep bar`) — cat is feeding another tool;
 *   the right call is usually `grep -f`-style, but that's a different
 *   anti-pattern (UUOC) and not what the read-vs-bash rule targets.
 * - Redirects (`cat foo > bar`) — that's a copy/write, not a read.
 * - Heredocs (`cat <<EOF`) — that's a shell construct, not a file read.
 * - `tail -f` / `tail --follow` — log monitoring, not file inspection.
 *
 * Detected forms (case-sensitive on the binary; whitespace-flexible):
 *   cat file.txt           gcat file.txt          cat -n file.txt
 *   head file.txt          head -n 20 file.txt    head -20 file.txt
 *   tail file.txt          tail -n 50 file.txt    tail -50 file.txt
 *   less file.txt          more file.txt          bat file.txt
 */
const PATTERNS: Array<{ regex: RegExp; label: string }> = [
	{ regex: /\bg?cat\s+(?!<)\S/, label: "cat" },
	{ regex: /\bhead\b(?:\s+-\S+)*\s+\S/, label: "head" },
	// tail without -f / --follow.
	{ regex: /\btail\b(?!\s+(?:-f\b|--follow\b))(?:\s+-\S+)*\s+\S/, label: "tail" },
	{ regex: /\b(?:less|more|bat)\s+\S/, label: "viewer" },
];

export const bashCatOrHeadOrTail: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];

	for (const ev of session.events) {
		if (ev.kind !== "tool_call" || ev.name !== "bash") continue;
		const cmd = getBashCommand(ev);
		if (!cmd) continue;

		// Bail on pipelines, redirects, and heredocs — see file header for why.
		if (cmd.includes("|") || cmd.includes(">") || cmd.includes("<<")) continue;

		for (const { regex, label } of PATTERNS) {
			if (regex.test(cmd)) {
				hits.push({
					ruleId: "bash-cat-or-head-or-tail",
					sessionId: session.header.id,
					filePath: session.filePath,
					lineRange: [ev.lineNumber, ev.lineNumber],
					message: `bash uses ${label} to dump a file (use the read tool instead)`,
				});
				break; // one hit per command
			}
		}
	}

	return hits;
};
