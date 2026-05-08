import type { AntiPatternRule } from "../types.js";
import { bashSedOrAwkEdit } from "./bash-sed-or-awk-edit.js";
import { editFailureThenReread } from "./edit-failure-then-reread.js";
import { grepForSymbol } from "./grep-for-symbol.js";
import { readAfterDocumentSymbols } from "./read-after-document-symbols.js";
import { readAfterGrepSameFile } from "./read-after-grep-same-file.js";
import { readTwiceNoEdit } from "./read-twice-no-edit.js";

/**
 * Registry of all anti-pattern rules. To add a new rule:
 *   1. Implement it as a pure function in a new file under this dir.
 *   2. Append it to `RULES`.
 *   3. Add a test file under `test/analysis/patterns/`.
 *
 * Rules are applied independently; their hits are unioned with no
 * de-duplication. Order is preserved in `runAllRules` output for
 * deterministic report generation.
 */
export const RULES: AntiPatternRule[] = [
	readTwiceNoEdit,
	grepForSymbol,
	readAfterDocumentSymbols,
	editFailureThenReread,
	bashSedOrAwkEdit,
	readAfterGrepSameFile,
];

export {
	bashSedOrAwkEdit,
	editFailureThenReread,
	grepForSymbol,
	readAfterDocumentSymbols,
	readAfterGrepSameFile,
	readTwiceNoEdit,
};

import type { AntiPatternHit, ParsedSession } from "../types.js";

/**
 * Run every registered rule against a session and concatenate hits.
 */
export function runAllRules(session: ParsedSession): AntiPatternHit[] {
	return RULES.flatMap((rule) => rule(session));
}
