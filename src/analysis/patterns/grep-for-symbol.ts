import type {
	AntiPatternHit,
	AntiPatternRule,
} from "../types.js";
import { getBashCommand } from "./util.js";

/**
 * Rule: a bash invocation of grep/rg/ack/ag whose search pattern looks
 * like a single identifier — i.e. the agent was looking for a SYMBOL,
 * which `lsp.workspace_symbols` (or `lsp.references`/`definition` if a
 * file is known) would have answered more precisely.
 *
 * Conservative: we only flag when the FIRST positional argument after
 * the search-binary is a bare identifier (no spaces, no special chars,
 * no regex metacharacters). Anchors `^` and `$` and surrounding
 * quotes are stripped before matching. Flags like `-rn`, `-i`,
 * `--include`, `-e <pat>` are skipped.
 *
 * Out of scope:
 * - Pipelines starting with a non-search command (`git log | grep foo`).
 *   These are usually output-filtering, not symbol search.
 * - Patterns with regex metacharacters (`foo|bar`, `f.o`) — those signal
 *   the agent KNOWS LSP can't help and is intentionally using regex.
 */
export const grepForSymbol: AntiPatternRule = (session) => {
	const hits: AntiPatternHit[] = [];

	for (const ev of session.events) {
		if (ev.kind !== "tool_call" || ev.name !== "bash") continue;
		const cmd = getBashCommand(ev);
		if (!cmd) continue;

		const pattern = extractSymbolPattern(cmd);
		if (pattern === null) continue;

		hits.push({
			ruleId: "grep-for-symbol",
			sessionId: session.header.id,
			filePath: session.filePath,
			lineRange: [ev.lineNumber, ev.lineNumber],
			message: `bash grep for bare symbol \`${pattern}\` (consider lsp workspace_symbols / references)`,
		});
	}

	return hits;
};

/**
 * If `command` is a search-binary invocation and the first positional
 * argument is a bare identifier, return the identifier. Otherwise null.
 *
 * Exported for direct unit testing.
 */
export function extractSymbolPattern(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;

	// First pipeline stage only — the rule cares about the originating cmd.
	const stage = trimmed.split(/[|;&]/)[0].trim();
	const tokens = tokenize(stage);
	if (tokens.length < 2) return null;

	const SEARCH_BINARIES = new Set(["grep", "rg", "ack", "ag", "fgrep", "egrep"]);
	if (!SEARCH_BINARIES.has(tokens[0])) return null;

	// Find the first non-flag, non-flag-arg positional. Flags consumed:
	//   single-char options without space (-rn) — skipped.
	//   --long-options with or without `=value` — skipped.
	//   `-e PATTERN`, `--regexp PATTERN`, `--include GLOB` — pattern follows;
	//   we treat `-e` as denoting that the next token is the pattern.
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "-e" || t === "--regexp" || t === "-f" || t === "--file") {
			// Pattern is the NEXT token.
			i++;
			if (i >= tokens.length) return null;
			return classify(tokens[i]);
		}
		if (t === "--include" || t === "--exclude" || t === "--include-dir" || t === "--exclude-dir") {
			i++; // skip the glob arg
			continue;
		}
		if (t.startsWith("-")) continue; // ordinary flag
		return classify(t);
	}
	return null;
}

/**
 * Return the token as a bare identifier if it qualifies, otherwise null.
 * Strips surrounding quotes and `^`/`$` anchors before checking.
 */
function classify(token: string): string | null {
	let s = token;
	// Strip matching surrounding quotes.
	if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
		s = s.slice(1, -1);
	}
	// Strip leading `^` and trailing `$` (regex anchors don't make a
	// pattern non-symbol-like — the substring inside is what matters).
	if (s.startsWith("^")) s = s.slice(1);
	if (s.endsWith("$")) s = s.slice(0, -1);
	// `\b` word-boundary anchors are similarly OK around an identifier.
	s = s.replace(/^\\b|\\b$/g, "");

	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
	return null;
}

/**
 * Minimal shell tokenizer: splits on whitespace, respects single and
 * double quotes (preserving content WITH quotes so the caller can
 * decide whether to strip them). Backslash-escapes are NOT supported —
 * if the agent emits `grep foo\ bar`, the rule will probably miss it,
 * which is fine for a heuristic.
 */
function tokenize(s: string): string[] {
	const tokens: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			buf += c;
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			buf += c;
			quote = c;
		} else if (/\s/.test(c)) {
			if (buf) {
				tokens.push(buf);
				buf = "";
			}
		} else {
			buf += c;
		}
	}
	if (buf) tokens.push(buf);
	return tokens;
}
