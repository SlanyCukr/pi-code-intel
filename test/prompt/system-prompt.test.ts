import { describe, it, expect } from "vitest";
import {
	type SystemPromptOptions,
	buildSystemPrompt,
} from "../../src/prompt/system-prompt.js";

const DEFAULT_OPTS: SystemPromptOptions = {
	activeTools: ["read", "edit", "write", "bash"],
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

	it("includes LSP operations when activeTools includes lsp", () => {
		const prompt = buildWith({
			activeTools: [...DEFAULT_OPTS.activeTools, "lsp"],
		});
		expect(prompt).toContain("LSP operations");
		expect(prompt).toContain("definition");
		expect(prompt).toContain("references");
		expect(prompt).toContain("document_symbols");
	});

	it("does NOT include LSP operations when lsp not in activeTools", () => {
		const prompt = buildWith({});
		expect(prompt).not.toContain("### LSP operations");
	});

	it("includes bash routing when activeTools includes bash", () => {
		const prompt = buildWith({});
		expect(prompt).toContain("automatically compressed");
		expect(prompt).toContain("token efficiency");
	});

	it("does NOT include bash routing when bash not in activeTools", () => {
		const prompt = buildWith({ activeTools: ["read", "edit"] });
		expect(prompt).not.toContain("automatically compressed");
	});

	it("includes code exploration when lsp in activeTools", () => {
		const prompt = buildWith({ activeTools: [...DEFAULT_OPTS.activeTools, "lsp"] });
		expect(prompt).toContain("Code exploration protocol");
	});

	it("does NOT include code exploration when lsp not in activeTools", () => {
		const prompt = buildWith({});
		expect(prompt).not.toContain("Code exploration protocol");
	});

	it("includes web fetch guidance when fetch in activeTools", () => {
		const prompt = buildWith({ activeTools: [...DEFAULT_OPTS.activeTools, "fetch"] });
		expect(prompt).toContain("Web fetch");
		expect(prompt).toContain("Use fetch for:");
	});

	it("does NOT include web fetch guidance when fetch not in activeTools", () => {
		const prompt = buildWith({});
		expect(prompt).not.toContain("## Web fetch");
	});

	it("includes context7 guidance when context7 in activeTools", () => {
		const prompt = buildWith({ activeTools: [...DEFAULT_OPTS.activeTools, "context7"] });
		expect(prompt).toContain("Library documentation (context7)");
		expect(prompt).toContain("Use context7 for:");
	});

	it("does NOT include context7 guidance when context7 not in activeTools", () => {
		const prompt = buildWith({});
		expect(prompt).not.toContain("Library documentation (context7)");
	});

	it("includes sub-agent delegation when agent in activeTools", () => {
		const prompt = buildWith({ activeTools: [...DEFAULT_OPTS.activeTools, "agent"] });
		expect(prompt).toContain("Sub-agent delegation");
		expect(prompt).toContain("Briefing");
		expect(prompt).toContain("Forward intelligence");
	});

	it("does NOT include sub-agent section when agent not in activeTools", () => {
		const prompt = buildWith({});
		expect(prompt).not.toContain("Sub-agent delegation");
	});

	it("includes editing section when tools include read and edit", () => {
		const prompt = buildWith({ activeTools: ["read", "edit", "write"] });
		expect(prompt).toContain("## Editing");
		expect(prompt).toContain("MUST read files before editing");
	});

	it("does NOT include editing section when tools lack read and edit", () => {
		const prompt = buildWith({ activeTools: ["bash"] });
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
