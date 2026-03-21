/**
 * Code intelligence workflow — injected into the system prompt
 * to guide the LLM toward using LSP and semantic search before grep/find.
 */

const WORKFLOW_TABLE = `
## Tool selection hierarchy for code search

BEFORE reaching for grep or find, evaluate whether search_code or lsp is more appropriate:

| Your goal | WRONG first choice | RIGHT first choice |
|---|---|---|
| Find code related to a concept | grep/find (keyword guessing) | search_code |
| Find where a symbol is defined | grep/find (file name guessing) | lsp definition or workspace_symbols |
| Find where a symbol is used | grep/find (name search) | lsp references |
| Find who calls a function | grep/find (name search) | lsp incoming_calls |
| What does a function call? | read (manual inspection) | lsp outgoing_calls |
| Understand a file's structure | read (entire file) | lsp document_symbols → targeted read |
| Find project documentation | grep/find (keyword search) | search_docs |

### Pre-tool checkpoint

Before calling grep or find: "Could search_code or lsp answer this in one call?" If yes, use them instead.
Before calling read to understand code: "Do I have an LSP anchor (file:line)?" If yes, use lsp definition/outgoing_calls first.

### When grep/find ARE the right choice

- Exact text patterns, string literals, regex, config values, error messages
- File name patterns when you need a specific filename or extension
- When lsp has no server for the file type and search_code returns nothing relevant
`;

const SUB_AGENT_GUIDANCE = `
## Sub-agent delegation

When a task is complex and benefits from focused analysis, delegate to a specialized sub-agent using the agent tool.
The sub-agent runs independently with its own context and returns a comprehensive result.

Guidelines:
- Use sub-agents for tasks that require deep, focused analysis (code review, architecture design, codebase exploration)
- Provide clear, specific task descriptions with all necessary context
- The sub-agent cannot see your conversation history — include everything it needs in the task description
- For exploration tasks, launch multiple sub-agents in parallel when they're investigating independent aspects
`;

export interface SystemPromptOptions {
	hasLsp: boolean;
	hasSearch: boolean;
	hasAgent: boolean;
}

/**
 * Build the code intelligence system prompt addition.
 * Only includes sections for tools that are actually active.
 */
export function buildCodeIntelPrompt(options: SystemPromptOptions): string {
	const sections: string[] = [];

	if (options.hasLsp || options.hasSearch) {
		sections.push(WORKFLOW_TABLE);
	}

	if (options.hasAgent) {
		sections.push(SUB_AGENT_GUIDANCE);
	}

	if (sections.length === 0) return "";
	return "\n" + sections.join("\n");
}
