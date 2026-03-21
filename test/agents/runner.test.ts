import { describe, it, expect } from "vitest";
import { loadTemplates, getTemplate, listTemplates } from "../../src/agents/runner.js";

describe("loadTemplates", () => {
	it("loads all 11 templates", () => {
		const templates = loadTemplates();
		expect(templates.size).toBe(11);
	});

	it("templates have correct categories", () => {
		const templates = loadTemplates();
		const categories = new Set(
			Array.from(templates.values()).map((t) => t.category),
		);
		expect(categories).toEqual(
			new Set(["feature-dev", "lsp-agents", "pr-review-toolkit"]),
		);
	});

	it("templates have valid model values", () => {
		const templates = loadTemplates();
		for (const [, template] of templates) {
			expect(["sonnet", "opus", "inherit"]).toContain(template.model);
		}
	});

	it("templates have non-empty system prompts", () => {
		const templates = loadTemplates();
		for (const [, template] of templates) {
			expect(template.systemPrompt.length).toBeGreaterThan(50);
		}
	});

	it("templates have non-empty tools arrays", () => {
		const templates = loadTemplates();
		for (const [, template] of templates) {
			expect(template.tools.length).toBeGreaterThan(0);
		}
	});
});

describe("getTemplate", () => {
	it("returns template by full name", () => {
		const t = getTemplate("feature-dev:code-architect");
		expect(t).not.toBeNull();
		expect(t!.name).toBe("code-architect");
		expect(t!.category).toBe("feature-dev");
		expect(t!.model).toBe("sonnet");
	});

	it("returns null for unknown name", () => {
		expect(getTemplate("unknown:agent")).toBeNull();
	});

	it("feature-dev agents use sonnet", () => {
		expect(getTemplate("feature-dev:code-architect")!.model).toBe("sonnet");
		expect(getTemplate("feature-dev:code-explorer")!.model).toBe("sonnet");
		expect(getTemplate("feature-dev:code-reviewer")!.model).toBe("sonnet");
	});

	it("lsp-agents use inherit", () => {
		expect(getTemplate("lsp-agents:lsp-explore")!.model).toBe("inherit");
		expect(getTemplate("lsp-agents:lsp-plan")!.model).toBe("inherit");
	});

	it("pr-review-toolkit has correct model assignments", () => {
		expect(getTemplate("pr-review-toolkit:code-reviewer")!.model).toBe("opus");
		expect(getTemplate("pr-review-toolkit:code-simplifier")!.model).toBe("opus");
		expect(getTemplate("pr-review-toolkit:comment-analyzer")!.model).toBe("inherit");
		expect(getTemplate("pr-review-toolkit:pr-test-analyzer")!.model).toBe("inherit");
		expect(getTemplate("pr-review-toolkit:silent-failure-hunter")!.model).toBe("inherit");
		expect(getTemplate("pr-review-toolkit:type-design-analyzer")!.model).toBe("inherit");
	});

	it("code-simplifier has write tools", () => {
		const t = getTemplate("pr-review-toolkit:code-simplifier")!;
		expect(t.tools).toContain("edit");
		expect(t.tools).toContain("write");
		expect(t.tools).toContain("bash");
	});

	it("code-explorer has only read tools", () => {
		const t = getTemplate("feature-dev:code-explorer")!;
		expect(t.tools).toContain("read");
		expect(t.tools).toContain("lsp");
		expect(t.tools).not.toContain("edit");
		expect(t.tools).not.toContain("write");
	});
});

describe("listTemplates", () => {
	it("returns all templates as array", () => {
		const templates = listTemplates();
		expect(templates.length).toBe(11);
	});
});
