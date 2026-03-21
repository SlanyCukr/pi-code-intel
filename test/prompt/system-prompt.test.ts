import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/prompt/system-prompt.js";

const DEFAULT_OPTS = {
	hasLsp: false,
	hasSearch: false,
	hasAgent: false,
	activeTools: ["read", "bash", "edit", "write"],
	toolSnippets: {},
	piSystemPrompt: "",
};

describe("buildSystemPrompt", () => {
	it("includes role section", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).toContain("expert coding agent");
	});

	it("includes active tools", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).toContain("Available tools:");
		expect(result).toContain("- read:");
		expect(result).toContain("- bash:");
		expect(result).toContain("- edit:");
		expect(result).toContain("- write:");
	});

	it("includes guidelines", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).toContain("Guidelines:");
		expect(result).toContain("Read files before editing");
		expect(result).toContain("Be concise");
	});

	it("includes date and cwd", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).toContain("Current date:");
		expect(result).toContain("Current working directory:");
	});

	it("does NOT include code intel section when LSP/search inactive", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).not.toContain("Tool selection hierarchy");
	});

	it("does NOT include sub-agent section when agent inactive", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).not.toContain("Sub-agent delegation");
	});

	it("includes workflow table when LSP is active", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			hasLsp: true,
			activeTools: [...DEFAULT_OPTS.activeTools, "lsp"],
		});
		expect(result).toContain("Tool selection hierarchy");
		expect(result).toContain("lsp definition");
		expect(result).toContain("lsp references");
		expect(result).toContain("lsp incoming_calls");
		expect(result).toContain("lsp outgoing_calls");
		expect(result).toContain("lsp document_symbols");
	});

	it("includes workflow table when search is active", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			hasSearch: true,
			activeTools: [...DEFAULT_OPTS.activeTools, "search_code"],
		});
		expect(result).toContain("Tool selection hierarchy");
		expect(result).toContain("search_code");
		expect(result).toContain("search_docs");
	});

	it("includes sub-agent guidance when agent is active", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			hasAgent: true,
			activeTools: [...DEFAULT_OPTS.activeTools, "agent"],
		});
		expect(result).toContain("Sub-agent delegation");
	});

	it("includes all sections when everything active", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			hasLsp: true,
			hasSearch: true,
			hasAgent: true,
			activeTools: [
				...DEFAULT_OPTS.activeTools,
				"lsp",
				"search_code",
				"search_docs",
				"agent",
			],
		});
		expect(result).toContain("Tool selection hierarchy");
		expect(result).toContain("Sub-agent delegation");
		expect(result).toContain("- lsp:");
		expect(result).toContain("- search_code:");
		expect(result).toContain("- agent:");
	});

	it("includes pre-tool checkpoint", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			hasLsp: true,
			hasSearch: true,
			activeTools: [...DEFAULT_OPTS.activeTools, "lsp", "search_code"],
		});
		expect(result).toContain("Pre-tool checkpoint");
	});

	it("includes when grep/find are the right choice", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			hasLsp: true,
			activeTools: [...DEFAULT_OPTS.activeTools, "lsp"],
		});
		expect(result).toContain("When grep/find ARE the right choice");
		expect(result).toContain("Exact text patterns");
	});

	it("extracts project context from pi prompt", () => {
		const piPrompt = `Some default stuff

# Project Context

Project-specific instructions and guidelines:

## AGENTS.md

Some agent guidelines here

Current date: 2024-01-01
Current working directory: /tmp`;

		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			piSystemPrompt: piPrompt,
		});
		expect(result).toContain("# Project Context");
		expect(result).toContain("Some agent guidelines here");
	});

	it("extracts skills from pi prompt", () => {
		const piPrompt = `Default stuff

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>test-skill</name>
    <description>A test skill</description>
    <location>/path/to/skill</location>
  </skill>
</available_skills>

Current date: 2024-01-01`;

		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			piSystemPrompt: piPrompt,
		});
		expect(result).toContain("available_skills");
		expect(result).toContain("test-skill");
	});

	it("uses custom tool snippets", () => {
		const result = buildSystemPrompt({
			...DEFAULT_OPTS,
			activeTools: [...DEFAULT_OPTS.activeTools, "my_tool"],
			toolSnippets: { my_tool: "Does something special" },
		});
		expect(result).toContain("- my_tool: Does something special");
	});

	it("does not include pi documentation paths", () => {
		const result = buildSystemPrompt(DEFAULT_OPTS);
		expect(result).not.toContain("Pi documentation");
		expect(result).not.toContain("docs/extensions.md");
	});
});
