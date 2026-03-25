/**
 * Code exploration guidance shared between the main system prompt
 * and sub-agent system prompts.
 *
 * Returns null when LSP is not available.
 */
export function buildCodeExplorationGuidance(
	hasLsp: boolean,
): string | null {
	if (!hasLsp) return null;

	const sections: string[] = [];

	// Core rule + read budget
	sections.push(`<contract>
## Code exploration protocol

Use LSP for structural code navigation. Every file:line from any source is an LSP anchor —
use LSP before reaching for read.

### Read budget

If you find yourself reading file after file, you are navigating by brute force. Each read returns an entire file section (~100-200 lines) when you often only need a single definition or call site. LSP can answer those questions with a single targeted call. Guideline: after your first read, ask yourself whether your next question could be answered by lsp instead of another read.
</contract>`);

	// Navigation chain + anchor discipline + tool selection (single consolidated reference)
	sections.push(`<instruction>
### Navigation chain

document_symbols is reconnaissance — a table of contents, not evidence. It tells you what symbols exist in a file but not how they behave, who calls them, or what they depend on. After document_symbols, follow up with a navigation operation (definition, references, incoming_calls, outgoing_calls) before reading or concluding anything about behavior — otherwise you are guessing from names alone.

### Anchor discipline

Every LSP call needs file path + line + character. Get anchors from:
- bash grep/find output (file:line format)
- document_symbols on a known file (returns all symbols with positions)
- Prior LSP results (e.g. definition gives you a new anchor)

### Tool selection

When you have an LSP anchor (file:line from any prior result), use the corresponding LSP operation — it gives the precise structural answer. grep is for discovery when you don't yet know where to look; once you have a location, LSP is always more accurate.

| Question | LSP call | Wrong choice when you have an anchor |
|---|---|---|
| Where is this defined? | definition | grep, document_symbols |
| Where is this used? | references | grep |
| Who calls this function? | incoming_calls | references (includes imports as noise), grep |
| What does this function call? | outgoing_calls | read (misses calls), grep |
| What symbol is this? | hover → then navigate | document_symbols alone |
| All symbols matching a name | workspace_symbols | grep |
| Understand a file's structure | document_symbols → targeted read | reading the entire file |

### Pre-tool checkpoint

Before calling read: "Do I have an LSP anchor?" If yes, use lsp first.
Before searching for callers: "Do I have an anchor?" If yes, use incoming_calls — not grep.

### When grep/find ARE the right choice

- Exact text patterns, string literals, regex, config values, error messages
- File name patterns when you need a specific filename or extension
- When lsp has no server for the file type
</instruction>`);

	// Anti-patterns + post-edit
	sections.push(`<critical>
### Anti-patterns

- Do NOT use document_symbols as proof of usage, call flow, or behavior — it only shows what exists, not how things relate
- Do NOT read entire files before trying document_symbols — get the table of contents first, then read only the relevant section
- Do NOT chain read after read when LSP navigation can narrow the search — each unnecessary read burns tokens on code you don't need
- Do NOT use grep when lsp can answer the same structural question — grep requires guessing keywords, lsp returns precise results
</critical>

<instruction>
### After editing code

Check LSP diagnostics before moving on. Fix any type errors or missing imports immediately.
</instruction>`);

	return sections.join("\n\n");
}
