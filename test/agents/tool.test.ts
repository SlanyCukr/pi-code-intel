import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/agents/runner.js", () => ({
	runSubAgent: vi.fn(),
}));
vi.mock("../../src/agents/templates.js", () => ({
	getTemplate: vi.fn(),
	listTemplates: vi.fn(),
	groupTemplatesByCategory: vi.fn(),
}));

import { runSubAgent } from "../../src/agents/runner.js";
import { getTemplate, groupTemplatesByCategory, listTemplates } from "../../src/agents/templates.js";
import { createAgentTool } from "../../src/agents/tool.js";
import type { AgentTemplate } from "../../src/agents/templates.js";

const mockGetTemplate = vi.mocked(getTemplate);
const mockListTemplates = vi.mocked(listTemplates);
const mockGroupTemplatesByCategory = vi.mocked(groupTemplatesByCategory);
const mockRunSubAgent = vi.mocked(runSubAgent);

const FAKE_TEMPLATES: AgentTemplate[] = [
	{
		name: "code-explorer",
		category: "feature-dev",
		description: "Explores the codebase",
		model: "sonnet",
		thinkingLevel: "medium",
		tools: ["read", "bash", "lsp"],
		systemPrompt: "You are a code explorer.",
	},
	{
		name: "code-architect",
		category: "feature-dev",
		description: "Designs the solution",
		model: "opus",
		thinkingLevel: "high",
		tools: ["read", "bash"],
		systemPrompt: "You are a code architect.",
	},
	{
		name: "code-simplifier",
		category: "pr-review-toolkit",
		description: "Simplifies code",
		model: "inherit",
		thinkingLevel: "low",
		tools: ["read", "edit", "bash"],
		systemPrompt: "You are a code simplifier.",
	},
];

function buildCategoryMap(templates: AgentTemplate[]): Map<string, AgentTemplate[]> {
	const byCategory = new Map<string, AgentTemplate[]>();
	for (const t of templates) {
		const list = byCategory.get(t.category) ?? [];
		list.push(t);
		byCategory.set(t.category, list);
	}
	return byCategory;
}

beforeEach(() => {
	vi.resetAllMocks();
	mockListTemplates.mockReturnValue(FAKE_TEMPLATES);
	mockGroupTemplatesByCategory.mockReturnValue(buildCategoryMap(FAKE_TEMPLATES));
	mockGetTemplate.mockReturnValue(null);
});

describe("buildDescription (via createAgentTool)", () => {
	it("description contains all template names", () => {
		const tool = createAgentTool(undefined);

		for (const t of FAKE_TEMPLATES) {
			expect(tool.description).toContain(t.name);
		}
	});

	it("description contains all category names", () => {
		const tool = createAgentTool(undefined);

		expect(tool.description).toContain("feature-dev");
		expect(tool.description).toContain("pr-review-toolkit");
	});

	it("description contains template descriptions", () => {
		const tool = createAgentTool(undefined);

		for (const t of FAKE_TEMPLATES) {
			expect(tool.description).toContain(t.description);
		}
	});

	it("formats inherit model as 'inherits parent model'", () => {
		const tool = createAgentTool(undefined);

		expect(tool.description).toContain("inherits parent model");
		expect(tool.description).not.toContain("(inherit)");
	});

	it("shows non-inherit model names directly", () => {
		const tool = createAgentTool(undefined);

		expect(tool.description).toContain("sonnet");
		expect(tool.description).toContain("opus");
	});
});

describe("createAgentTool", () => {
	it("returns a tool with name 'agent'", () => {
		const tool = createAgentTool(undefined);

		expect(tool.name).toBe("agent");
	});

	it("returns a tool with a non-empty description", () => {
		const tool = createAgentTool(undefined);

		expect(tool.description.length).toBeGreaterThan(0);
	});

	it("returns a tool with an execute function", () => {
		const tool = createAgentTool(undefined);

		expect(typeof tool.execute).toBe("function");
	});

	it("tool has parameters schema", () => {
		const tool = createAgentTool(undefined);

		expect(tool.parameters).toBeDefined();
	});
});

describe("execute", () => {
	function makeCtx() {
		return {
			cwd: "/fake/cwd",
			model: {} as any,
			sessionManager: {
				getSessionDir: vi.fn().mockReturnValue(undefined),
			},
		} as any;
	}

	it("throws when template name is unknown", async () => {
		mockGetTemplate.mockReturnValue(null);

		const tool = createAgentTool(undefined);

		await expect(
			tool.execute("id", { type: "unknown:agent", task: "do something" }, undefined, undefined, makeCtx()),
		).rejects.toThrow("Unknown agent type: unknown:agent");
	});

	it("error message includes available types from listTemplates", async () => {
		mockGetTemplate.mockReturnValue(null);

		const tool = createAgentTool(undefined);

		await expect(
			tool.execute("id", { type: "bad:type", task: "task" }, undefined, undefined, makeCtx()),
		).rejects.toThrow("feature-dev:code-explorer");
	});

	it("returns output from runSubAgent on success", async () => {
		const template = FAKE_TEMPLATES[0]!;
		mockGetTemplate.mockReturnValue(template);
		mockRunSubAgent.mockResolvedValue({ output: "Analysis complete." });

		const tool = createAgentTool(undefined);

		const result = await tool.execute(
			"id",
			{ type: "feature-dev:code-explorer", task: "Explore the codebase" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.content).toEqual([{ type: "text", text: "Analysis complete." }]);
	});

	it("throws when runSubAgent returns an error", async () => {
		const template = FAKE_TEMPLATES[0]!;
		mockGetTemplate.mockReturnValue(template);
		mockRunSubAgent.mockResolvedValue({
			output: "Partial output here",
			error: "Agent failed",
		});

		const tool = createAgentTool(undefined);

		await expect(
			tool.execute("id", { type: "feature-dev:code-explorer", task: "task" }, undefined, undefined, makeCtx()),
		).rejects.toThrow("Agent failed");
	});

	it("calls onUpdate with initial task preview", async () => {
		const template = FAKE_TEMPLATES[0]!;
		mockGetTemplate.mockReturnValue(template);
		mockRunSubAgent.mockResolvedValue({ output: "done" });

		const tool = createAgentTool(undefined);
		const onUpdate = vi.fn();

		await tool.execute(
			"id",
			{ type: "feature-dev:code-explorer", task: "Explore the codebase" },
			undefined,
			onUpdate,
			makeCtx(),
		);

		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.arrayContaining([
					expect.objectContaining({ type: "text" }),
				]),
			}),
		);
	});

	it("truncates long task previews to 120 characters", async () => {
		const template = FAKE_TEMPLATES[0]!;
		mockGetTemplate.mockReturnValue(template);
		mockRunSubAgent.mockResolvedValue({ output: "done" });

		const longTask = "A".repeat(200);
		const tool = createAgentTool(undefined);
		const onUpdate = vi.fn();

		await tool.execute(
			"id",
			{ type: "feature-dev:code-explorer", task: longTask },
			undefined,
			onUpdate,
			makeCtx(),
		);

		const firstCall = onUpdate.mock.calls[0]![0];
		const text = firstCall.content[0].text as string;
		// Preview portion after "[feature-dev:code-explorer] " should be truncated
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(200);
	});
});
