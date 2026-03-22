import { describe, it, expect } from "vitest";
import { loadTemplates, getTemplate, listTemplates, extractFinalReport, isInSubAgent } from "../../src/agents/runner.js";

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

	it("critical agents use expected models", () => {
		const expectations: Record<string, string> = {
			"feature-dev:code-architect": "opus",
			"feature-dev:code-reviewer": "opus",
			"pr-review-toolkit:code-reviewer": "opus",
			"pr-review-toolkit:code-simplifier": "opus",
			"pr-review-toolkit:silent-failure-hunter": "opus",
		};
		for (const [name, expectedModel] of Object.entries(expectations)) {
			const t = getTemplate(name);
			expect(t, `${name} should exist`).not.toBeNull();
			expect(t!.model, `${name} should use ${expectedModel}`).toBe(expectedModel);
		}
	});
});

describe("extractFinalReport", () => {
	it("returns text from the last assistant message", () => {
		const messages = [
			{ role: "assistant", content: "first message" },
			{ role: "user", content: "follow up" },
			{ role: "assistant", content: "final report" },
		];
		expect(extractFinalReport(messages)).toBe("final report");
	});

	it("handles array content with text blocks", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "part one" },
					{ type: "tool_use", id: "1" },
					{ type: "text", text: "part two" },
				],
			},
		];
		expect(extractFinalReport(messages)).toBe("part one\n\npart two");
	});

	it("skips tool-use-only assistant messages and falls back to previous", () => {
		const messages = [
			{ role: "assistant", content: "real report" },
			{ role: "user", content: "ok" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "1" }],
			},
		];
		expect(extractFinalReport(messages)).toBe("real report");
	});

	it("skips whitespace-only last message and falls back", () => {
		const messages = [
			{ role: "assistant", content: "actual content" },
			{ role: "assistant", content: "   \n  " },
		];
		expect(extractFinalReport(messages)).toBe("actual content");
	});

	it("returns empty string when no assistant messages exist", () => {
		const messages = [{ role: "user", content: "hello" }];
		expect(extractFinalReport(messages)).toBe("");
	});

	it("returns empty string for empty messages array", () => {
		expect(extractFinalReport([])).toBe("");
	});
});

describe("isInSubAgent", () => {
	it("returns false at baseline", () => {
		expect(isInSubAgent()).toBe(false);
	});
});
