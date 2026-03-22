/**
 * Code exploration guidance shared between the main system prompt
 * and sub-agent system prompts.
 *
 * Returns null when neither LSP nor search is available.
 */
export function buildCodeExplorationGuidance(
	hasLsp: boolean,
	hasSearch: boolean,
): string | null {
	if (!hasLsp && !hasSearch) return null;

	const sections: string[] = [];

	// Core rule
	if (hasSearch && hasLsp) {
		sections.push(`<contract>
## Code exploration protocol

Core rule: **search_code discovers, lsp explains.**

Use search_code to find code by meaning. As soon as you have a file path and line number
from any source (search_code hit, grep hit, or prior LSP result), that is your LSP anchor —
use LSP for follow-up before reaching for read.

### Read budget

Maximum 1 read before the first LSP call. Maximum 3 reads before at least 2 LSP calls.
If you hit the budget, stop reading and switch to LSP.
</contract>`);
	} else if (hasSearch) {
		sections.push(`<contract>
## Code exploration protocol

Use search_code to find code by meaning — it understands concepts, not just text patterns.
For open-ended exploration, prefer search_code over multiple rounds of grep/find.
</contract>`);
	} else if (hasLsp) {
		sections.push(`<contract>
## Code exploration protocol

Use LSP for structural code navigation. Every file:line from any source is an LSP anchor —
use LSP before reaching for read.

### Read budget

Maximum 1 read before the first LSP call. Maximum 3 reads before at least 2 LSP calls.
If you hit the budget, stop reading and switch to LSP.
</contract>`);
	}

	// Navigation chain + anchor discipline (LSP)
	if (hasLsp) {
		sections.push(`<instruction>
### Navigation chain

document_symbols is reconnaissance — a table of contents, not evidence. After document_symbols,
you MUST call a navigation operation (definition, references, incoming_calls, outgoing_calls)
before read or concluding anything about behavior.

### Anchor discipline

Every LSP call needs file path + line + character. Get anchors from:
- search_code results (return file path + line)
- grep hits
- document_symbols on a known file (returns all symbols with positions)
- Prior LSP results (e.g. definition gives you a new anchor)
</instruction>

<critical>
### Mandatory navigation triggers

Before searching for callers, references, or definitions: if you have an LSP anchor (file:line from any prior result), you MUST use the corresponding LSP operation — not search_code, not grep, not read.

| Question intent | Required LSP call | Wrong substitute |
|---|---|---|
| Where is this defined? | definition | document_symbols, hover, grep, search_code |
| Where is this used? | references | document_symbols, hover, grep, search_code |
| Who calls this function? | incoming_calls | references, grep, search_code |
| What does this function call? | outgoing_calls | read, grep, search_code |
| What symbol is this? | hover → then navigate | document_symbols alone |
| All symbols matching a name | workspace_symbols | grep |
</critical>`);
	}

	// Tool selection hierarchy table
	const rows: string[] = [];
	rows.push("## Tool selection hierarchy");
	rows.push("");
	rows.push(
		"BEFORE reaching for grep or find, evaluate whether a smarter tool can answer in one call:",
	);
	rows.push("");
	rows.push("| Your goal | WRONG first choice | RIGHT first choice |");
	rows.push("|---|---|---|");

	if (hasSearch) {
		rows.push(
			"| Find code related to a concept | grep/find (keyword guessing) | search_code |",
		);
	}
	if (hasLsp) {
		rows.push(
			"| Find where a symbol is defined | grep/find (file name guessing) | lsp definition or workspace_symbols |",
		);
		rows.push(
			"| Find where a symbol is used | grep/find (name search) | lsp references |",
		);
		rows.push(
			"| Find who calls a function | grep/find (name search) | lsp incoming_calls |",
		);
		rows.push(
			"| What does a function call? | read (manual inspection) | lsp outgoing_calls |",
		);
		rows.push(
			"| Understand a file's structure | read (entire file) | lsp document_symbols → targeted read |",
		);
	}
	if (hasSearch) {
		rows.push(
			"| Find project documentation | grep/find (keyword search) | search_docs |",
		);
	}

	rows.push("");
	rows.push("### Pre-tool checkpoint");
	rows.push("");

	if (hasSearch) {
		rows.push(
			'Before calling grep or find: "Could search_code or lsp answer this in one call?" If yes, use them instead.',
		);
	}
	if (hasLsp) {
		rows.push(
			'Before calling read to understand code: "Do I have an LSP anchor (file:line)?" If yes, use lsp definition/outgoing_calls first.',
		);
		rows.push(
			'Before searching for callers or references: "Do I have an LSP anchor?" If yes, use lsp incoming_calls/references — not search_code or grep.',
		);
	}

	rows.push("");
	rows.push("### When grep/find ARE the right choice");
	rows.push("");
	rows.push(
		"- Exact text patterns, string literals, regex, config values, error messages",
	);
	rows.push(
		"- File name patterns when you need a specific filename or extension",
	);
	if (hasLsp && hasSearch) {
		rows.push(
			"- When lsp has no server for the file type and search_code returns nothing relevant",
		);
	}

	sections.push(rows.join("\n"));

	// Anti-patterns (LSP)
	if (hasLsp) {
		sections.push(`<critical>
### Anti-patterns

- Do NOT use document_symbols as proof of usage, call flow, or behavior
- Do NOT use references to find callers — use incoming_calls (more precise, no noise from imports/types)
- Do NOT read a function body to find what it calls — use outgoing_calls
- Do NOT read entire files before trying document_symbols
- Do NOT chain read after read when LSP navigation can narrow the search
</critical>

<instruction>
### After editing code

Check LSP diagnostics before moving on. Fix any type errors or missing imports immediately.
</instruction>`);
	}

	return sections.join("\n\n");
}
