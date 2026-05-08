import type {
	AntiPatternHit,
	AntiPatternRule,
} from "../types.js";
import { getBashCommand } from "./util.js";

/**
 * Rule: bash invocation using `sed -i` (in-place) or an `awk` /
 * redirect-to-file pattern that's clearly an edit attempt. The `edit`
 * tool exists for this exact case; using sed/awk bypasses the safety
 * properties of edit (exact-text matching, fail-fast on stale content).
 *
 * Detected forms (case-sensitive on the binary; whitespace-flexible):
 *   sed -i ...            sed -i.bak ...           sed -E -i ...
 *   sed -i '' ...         (BSD form on macOS)
 *   gsed -i ...
 *   awk ... > file        awk ... >> file
 *   perl -i -pe ...       perl -i.bak -pe ...
 *
 * Out of scope:
 * - `cat > file` and `echo > file` — these are file CREATION, not in-
 *   place editing. The `write` tool is the right call but the harm is
 *   smaller; we don't flag.
 * - `tee` — used legitimately for both reading and writing; ambiguous.
 */
const PATTERNS: Array<{ regex: RegExp; label: string }> = [
	{ regex: /\bg?sed\s+(?:-[a-zA-Z]*\s+)*-i\b/, label: "sed -i" },
	{ regex: /\bperl\s+(?:-[a-zA-Z]*\s+)*-i(?:\.\w+)?\b/, label: "perl -i" },
	// awk that redirects its output to a file is editing-by-rewrite.
	{ regex: /\bawk\b[^|;&]*>{1,2}\s*\S+/, label: "awk > file" },
];

export const bashSedOrAwkEdit: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];

	for (const ev of session.events) {
		if (ev.kind !== "tool_call" || ev.name !== "bash") continue;
		const cmd = getBashCommand(ev);
		if (!cmd) continue;

		for (const { regex, label } of PATTERNS) {
			if (regex.test(cmd)) {
				hits.push({
					ruleId: "bash-sed-or-awk-edit",
					sessionId: session.header.id,
					filePath: session.filePath,
					lineRange: [ev.lineNumber, ev.lineNumber],
					message: `bash uses ${label} for in-place editing (use the edit tool instead)`,
				});
				break; // one hit per command, even if multiple patterns match
			}
		}
	}

	return hits;
};
