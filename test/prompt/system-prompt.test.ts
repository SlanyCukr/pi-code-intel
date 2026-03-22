import { describe, it, expect } from "vitest";
import {
	type SystemPromptOptions,
	buildSystemPrompt,
} from "../../src/prompt/system-prompt.js";

const DEFAULT_OPTS: SystemPromptOptions = {
	hasLsp: false,
	hasSearch: false,
	hasAgent: false,
	activeTools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
	toolSnippets: {},
	piSystemPrompt: "",
};

function buildWith(overrides: Partial<SystemPromptOptions>): string {
	return buildSystemPrompt({ ...DEFAULT_OPTS, ...overrides });
}

describe("buildSystemPrompt", () => {
	it("includes identity/role section", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("expert coding agent");
		expect(prompt).toContain("Daneel");
	});

	it("includes active tools listing", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("Available tools:");
		for (const tool of DEFAULT_OPTS.activeTools) {
			expect(prompt).toContain(`- ${tool}:`);
		}
	});

	it("includes date and cwd", () => {
		const prompt = buildWith({});
		const today = new Date().toISOString().slice(0, 10);
		expect(prompt).toContain(`Current date: ${today}`);
		expect(prompt).toContain("Current working directory:");
	});

	it("includes LSP operations when hasLsp=true and activeTools includes lsp", () => {
		const prompt = buildWith({
			hasLsp: true,
			activeTools: [...DEFAULT_OPTS.activeTools, "lsp"],
		});
		expect(prompt).toContain("LSP operations");
		expect(prompt).toContain("definition");
		expect(prompt).toContain("references");
		expect(prompt).toContain("document_symbols");
	});

	it("does NOT include LSP operations when hasLsp=false", () => {
		const prompt = buildWith({
			hasLsp: false,
			activeTools: [...DEFAULT_OPTS.activeTools, "lsp"],
		});
		expect(prompt).not.toContain("### LSP operations");
	});

	it("does NOT include LSP operations when lsp not in activeTools", () => {
		const prompt = buildWith({ hasLsp: true });
		expect(prompt).not.toContain("### LSP operations");
	});

	it("includes bash routing when activeTools includes bash", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("MUST NOT use bash for code exploration");
	});

	it("does NOT include bash routing when bash not in activeTools", () => {
		const prompt = buildWith({ activeTools: ["read", "edit"] });
		expect(prompt).not.toContain("MUST NOT use bash for code exploration");
	});

	it("includes code exploration when hasLsp=true", () => {
		const prompt = buildWith({ hasLsp: true });
		expect(prompt).toContain("Code exploration protocol");
	});

	it("includes code exploration when hasSearch=true", () => {
		const prompt = buildWith({ hasSearch: true });
		expect(prompt).toContain("Code exploration protocol");
	});

	it("does NOT include code exploration when both hasLsp=false and hasSearch=false", () => {
		const prompt = buildWith({ hasLsp: false, hasSearch: false });
		expect(prompt).not.toContain("Code exploration protocol");
	});

	it("includes sub-agent delegation when hasAgent=true", () => {
		const prompt = buildWith({ hasAgent: true });
		expect(prompt).toContain("Sub-agent delegation");
		expect(prompt).toContain("Briefing");
		expect(prompt).toContain("Forward intelligence");
	});

	it("does NOT include sub-agent section when hasAgent=false", () => {
		const prompt = buildWith({ hasAgent: false });
		expect(prompt).not.toContain("Sub-agent delegation");
	});

	it("includes editing section when tools include read and edit", () => {
		const prompt = buildWith({ activeTools: ["read", "edit", "write"] });
		expect(prompt).toContain("## Editing");
		expect(prompt).toContain("MUST read files before editing");
	});

	it("does NOT include editing section when tools lack read and edit", () => {
		const prompt = buildWith({ activeTools: ["bash", "grep"] });
		expect(prompt).not.toContain("## Editing");
	});

	it("always includes design integrity", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("Design integrity");
	});

	it("always includes debugging discipline", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("Debugging discipline");
	});

	it("always includes planning doctrine", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("Planning doctrine");
	});

	it("custom tool snippets override built-in descriptions", () => {
		const customDesc = "My custom read tool description";
		const prompt = buildWith({
			toolSnippets: { read: customDesc },
		});
		expect(prompt).toContain(`- read: ${customDesc}`);
		expect(prompt).not.toContain("Read file contents (text or images)");
	});
});

describe("extractProjectContext (via buildSystemPrompt)", () => {
	it("extracts project context from piSystemPrompt", () => {
		const piPrompt = [
			"Some preamble text",
			"# Project Context",
			"This project uses TypeScript and vitest for testing.",
			"Current date: 2026-03-22",
		].join("\n");
		const prompt = buildWith({ piSystemPrompt: piPrompt });
		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain(
			"This project uses TypeScript and vitest for testing.",
		);
	});

	it("extracts skills section from piSystemPrompt", () => {
		const piPrompt = [
			"Some preamble text",
			"The following skills provide specialized instructions for the agent.",
			"- /commit: Create a git commit",
			"- /review: Review code changes",
			"Current date: 2026-03-22",
		].join("\n");
		const prompt = buildWith({ piSystemPrompt: piPrompt });
		expect(prompt).toContain(
			"The following skills provide specialized instructions",
		);
		expect(prompt).toContain("/commit");
	});
});
