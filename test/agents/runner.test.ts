import { describe, it, expect } from "vitest";
import { loadTemplates, getTemplate, listTemplates } from "../../src/agents/runner.js";

describe("agent templates", () => {
	it("loads templates from disk", () => {
		const templates = loadTemplates();
		expect(templates.size).toBeGreaterThan(0);
	});

	it("all templates have valid model values", () => {
		for (const [, t] of loadTemplates()) {
			expect(["sonnet", "opus", "inherit"]).toContain(t.model);
		}
	});

	it("all templates have non-empty system prompts and tools", () => {
		for (const [, t] of loadTemplates()) {
			expect(t.systemPrompt.length).toBeGreaterThan(50);
			expect(t.tools.length).toBeGreaterThan(0);
		}
	});

	it("getTemplate returns by full name", () => {
		const templates = loadTemplates();
		const first = templates.entries().next().value!;
		const fullName = `${first[1].category}:${first[1].name}`;
		expect(getTemplate(fullName)).not.toBeNull();
	});

	it("getTemplate returns null for unknown name", () => {
		expect(getTemplate("unknown:agent")).toBeNull();
	});

	it("listTemplates returns same count as loadTemplates", () => {
		expect(listTemplates().length).toBe(loadTemplates().size);
	});

	it("has exactly 9 templates", () => {
		const templates = loadTemplates();
		expect(templates.size).toBe(9);
	});

	it("has exactly the categories feature-dev and pr-review-toolkit", () => {
		const templates = loadTemplates();
		const categories = new Set<string>();
		for (const [, t] of templates) {
			categories.add(t.category);
		}
		expect(Array.from(categories).sort()).toEqual([
			"feature-dev",
			"pr-review-toolkit",
		]);
	});

	it("feature-dev code-architect uses opus model", () => {
		const t = getTemplate("feature-dev:code-architect");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("opus");
	});

	it("feature-dev code-reviewer uses opus model", () => {
		const t = getTemplate("feature-dev:code-reviewer");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("opus");
	});

	it("feature-dev code-explorer uses sonnet model", () => {
		const t = getTemplate("feature-dev:code-explorer");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("sonnet");
	});

	it("pr-review-toolkit code-reviewer uses opus model", () => {
		const t = getTemplate("pr-review-toolkit:code-reviewer");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("opus");
	});

	it("pr-review-toolkit code-simplifier uses opus model", () => {
		const t = getTemplate("pr-review-toolkit:code-simplifier");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("opus");
	});

	it("pr-review-toolkit comment-analyzer uses inherit model", () => {
		const t = getTemplate("pr-review-toolkit:comment-analyzer");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("inherit");
	});

	it("pr-review-toolkit pr-test-analyzer uses inherit model", () => {
		const t = getTemplate("pr-review-toolkit:pr-test-analyzer");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("inherit");
	});

	it("pr-review-toolkit silent-failure-hunter uses inherit model", () => {
		const t = getTemplate("pr-review-toolkit:silent-failure-hunter");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("inherit");
	});

	it("pr-review-toolkit type-design-analyzer uses inherit model", () => {
		const t = getTemplate("pr-review-toolkit:type-design-analyzer");
		expect(t).not.toBeNull();
		expect(t!.model).toBe("inherit");
	});

	it("read-only agent code-explorer does NOT have edit or write tools", () => {
		const t = getTemplate("feature-dev:code-explorer");
		expect(t).not.toBeNull();
		expect(t!.tools).not.toContain("edit");
		expect(t!.tools).not.toContain("write");
	});

	it("write agent code-simplifier has edit, write, and bash tools", () => {
		const t = getTemplate("pr-review-toolkit:code-simplifier");
		expect(t).not.toBeNull();
		expect(t!.tools).toContain("edit");
		expect(t!.tools).toContain("write");
		expect(t!.tools).toContain("bash");
	});

	it("all templates include search_docs in their tools list", () => {
		for (const [name, t] of loadTemplates()) {
			expect(t.tools, `${name} should include search_docs`).toContain(
				"search_docs",
			);
		}
	});
});
