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
});
