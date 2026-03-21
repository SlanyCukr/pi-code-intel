export interface SystemPromptOptions {
	hasLsp: boolean;
	hasSearch: boolean;
	hasAgent: boolean;
	/** Tool names currently active */
	activeTools: string[];
	/** Tool prompt snippets from extensions (name -> one-liner) */
	toolSnippets: Record<string, string>;
	/** The system prompt pi built (we extract context files, skills, date, cwd from it) */
	piSystemPrompt: string;
}

/**
 * Build the complete system prompt, replacing pi's default.
 *
 * We keep pi's project context (AGENTS.md, skills) but rewrite the core
 * instructions, tool guidance, and add code intelligence workflow.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
	const {
		hasLsp,
		hasSearch,
		hasAgent,
		activeTools,
		toolSnippets,
		piSystemPrompt,
	} = options;

	const sections: string[] = [];

	// 1. Role
	sections.push(ROLE_SECTION);

	// 2. Tools
	sections.push(buildToolsSection(activeTools, toolSnippets));

	// 3. Guidelines
	sections.push(buildGuidelinesSection(activeTools));

	// 4. Code intelligence workflow (if LSP or search active)
	if (hasLsp || hasSearch) {
		sections.push(buildCodeIntelSection(hasLsp, hasSearch));
	}

	// 5. Sub-agent guidance (if agent tool active)
	if (hasAgent) {
		sections.push(SUB_AGENT_SECTION);
	}

	// 6. Extract and append project context from pi's prompt (AGENTS.md, skills, etc.)
	const projectContext = extractProjectContext(piSystemPrompt);
	if (projectContext) {
		sections.push(projectContext);
	}

	// 7. Date and working directory
	const date = new Date().toISOString().slice(0, 10);
	const cwd = process.cwd().replace(/\\/g, "/");
	sections.push(`Current date: ${date}\nCurrent working directory: ${cwd}`);

	return sections.join("\n\n");
}

// -- Sections --

const ROLE_SECTION = `You are an expert coding agent with deep code intelligence capabilities. You help users by reading, understanding, searching, and modifying codebases using precise tools.

You have access to Language Server Protocol (LSP) for structural code navigation, semantic search for conceptual code discovery, and specialized sub-agents for complex tasks. Use these capabilities proactively — do not fall back to text search when structural or semantic tools can answer in one call.`;

function buildToolsSection(
	activeTools: string[],
	toolSnippets: Record<string, string>,
): string {
	const builtInDescriptions: Record<string, string> = {
		read: "Read file contents (text or images)",
		bash: "Execute shell commands",
		edit: "Make surgical text replacements in files (old text must match exactly)",
		write: "Create new files or complete rewrites",
		grep: "Search file contents for regex patterns (respects .gitignore)",
		find: "Find files by glob pattern (respects .gitignore)",
		ls: "List directory contents",
		lsp: "Language Server Protocol — definition, references, hover, diagnostics, symbols, call hierarchy, rename, code actions",
		search_code: "Semantic code search — find code by meaning, not just text patterns",
		search_docs: "Semantic documentation search — find relevant docs by concept",
		agent: "Delegate tasks to specialized sub-agents that run independently",
	};

	const lines = activeTools.map((name) => {
		const desc =
			toolSnippets[name] ??
			builtInDescriptions[name] ??
			name;
		return `- ${name}: ${desc}`;
	});

	return `Available tools:\n${lines.join("\n")}`;
}

function buildGuidelinesSection(activeTools: string[]): string {
	const has = (name: string) => activeTools.includes(name);
	const guidelines: string[] = [];

	// Core editing guidelines
	if (has("read") && has("edit")) {
		guidelines.push(
			"Read files before editing — you must understand the code before modifying it",
		);
	}
	if (has("edit")) {
		guidelines.push(
			"Use edit for precise changes (old text must match exactly, include enough context for uniqueness)",
		);
	}
	if (has("write")) {
		guidelines.push("Use write only for new files or complete rewrites");
	}

	// Always
	guidelines.push("Be concise in your responses");
	guidelines.push("Show file paths clearly when referencing code");
	guidelines.push(
		"When summarizing actions, output text directly — do not use bash to echo results",
	);

	return `Guidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}`;
}

function buildCodeIntelSection(hasLsp: boolean, hasSearch: boolean): string {
	const rows: string[] = [];

	rows.push("## Tool selection hierarchy for code search");
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

	return rows.join("\n");
}

const SUB_AGENT_SECTION = `## Sub-agent delegation

When a task is complex and benefits from focused analysis, delegate to a specialized sub-agent using the agent tool. The sub-agent runs independently with its own context and returns a comprehensive result.

Guidelines:
- Use sub-agents for tasks that require deep, focused analysis (code review, architecture design, codebase exploration)
- Provide clear, specific task descriptions with all necessary context
- The sub-agent cannot see your conversation history — include everything it needs in the task description
- For exploration tasks, launch multiple sub-agents in parallel when they're investigating independent aspects`;

/**
 * Extract project context sections from pi's built system prompt.
 *
 * Pi appends these sections:
 * - "# Project Context" with AGENTS.md, CLAUDE.md contents
 * - "<available_skills>" XML block
 * - "Current date:" and "Current working directory:" lines
 *
 * We extract project context and skills, but skip date/cwd (we add our own).
 */
function extractProjectContext(piPrompt: string): string | null {
	const parts: string[] = [];

	// Extract "# Project Context" section
	const contextIdx = piPrompt.indexOf("# Project Context");
	if (contextIdx !== -1) {
		// Find where it ends (before skills, date, or end of string)
		let endIdx = piPrompt.indexOf("\nThe following skills", contextIdx);
		if (endIdx === -1) endIdx = piPrompt.indexOf("\nCurrent date:", contextIdx);
		if (endIdx === -1) endIdx = piPrompt.length;
		const contextSection = piPrompt.slice(contextIdx, endIdx).trim();
		if (contextSection.length > 20) {
			parts.push(contextSection);
		}
	}

	// Extract skills section
	const skillsIdx = piPrompt.indexOf(
		"The following skills provide specialized instructions",
	);
	if (skillsIdx !== -1) {
		let endIdx = piPrompt.indexOf("\nCurrent date:", skillsIdx);
		if (endIdx === -1) endIdx = piPrompt.length;
		const skillsSection = piPrompt.slice(skillsIdx, endIdx).trim();
		if (skillsSection.length > 20) {
			parts.push(skillsSection);
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}

// Legacy export for backward compatibility
export type { SystemPromptOptions as SystemPromptOptionsLegacy };
