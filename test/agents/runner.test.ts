import { describe, it, expect } from "vitest";
import { extractFinalReport, isInSubAgent } from "../../src/agents/runner.js";
import { loadTemplates, getTemplate, listTemplates, templateNeedsWriteTools } from "../../src/agents/templates.js";

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

	it("all templates have valid thinkingLevel values", () => {
		const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
		for (const [name, t] of loadTemplates()) {
			expect(valid, `${name} has invalid thinkingLevel: ${t.thinkingLevel}`).toContain(t.thinkingLevel);
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

	it("read-only agent intent-reviewer does NOT have edit or write tools", () => {
		const t = getTemplate("pr-review-toolkit:intent-reviewer");
		expect(t).not.toBeNull();
		expect(t!.tools).not.toContain("edit");
		expect(t!.tools).not.toContain("write");
	});

	it("intent-reviewer has bash tool for git diff access", () => {
		const t = getTemplate("pr-review-toolkit:intent-reviewer");
		expect(t).not.toBeNull();
		expect(t!.tools).toContain("bash");
	});

	it("code-simplifier has edit and bash tools but not write", () => {
		const t = getTemplate("pr-review-toolkit:code-simplifier");
		expect(t).not.toBeNull();
		expect(t!.tools).toContain("edit");
		expect(t!.tools).toContain("bash");
		expect(t!.tools).not.toContain("write");
	});

	it("no templates include search_code or search_docs", () => {
		for (const [name, t] of loadTemplates()) {
			expect(t.tools, `${name} should not include search_code`).not.toContain("search_code");
			expect(t.tools, `${name} should not include search_docs`).not.toContain("search_docs");
		}
	});

	it("no templates use standalone find or ls tools — use bash instead", () => {
		for (const [name, t] of loadTemplates()) {
			expect(t.tools, `${name} should not include find`).not.toContain("find");
			expect(t.tools, `${name} should not include ls`).not.toContain("ls");
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

describe("templateNeedsWriteTools", () => {
	const makeTemplate = (tools: string[]) => ({
		name: "test",
		category: "test",
		description: "test",
		model: "sonnet" as const,
		thinkingLevel: "medium" as const,
		tools,
		systemPrompt: "test",
	});

	it("returns true when template has edit", () => {
		expect(templateNeedsWriteTools(makeTemplate(["read", "edit", "bash"]))).toBe(true);
	});

	it("returns true when template has write", () => {
		expect(templateNeedsWriteTools(makeTemplate(["read", "write"]))).toBe(true);
	});

	it("returns false when template only has bash (no edit/write)", () => {
		expect(templateNeedsWriteTools(makeTemplate(["read", "bash", "lsp"]))).toBe(false);
	});

	it("returns false for read-only templates", () => {
		expect(templateNeedsWriteTools(makeTemplate(["read", "lsp"]))).toBe(false);
	});
});

describe("isInSubAgent", () => {
	it("returns false at baseline", () => {
		expect(isInSubAgent()).toBe(false);
	});
});
