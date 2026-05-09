import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractFinalReport, isInSubAgent, runSubAgent } from "../../src/agents/runner.js";
import { loadTemplates, getTemplate, listTemplates, templateNeedsWriteTools } from "../../src/agents/templates.js";

// Mock createAgentSession for runSubAgent tests
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
	return {
		...actual,
		createAgentSession: vi.fn(actual.createAgentSession),
	};
});

import { createAgentSession } from "@mariozechner/pi-coding-agent";
const mockCreateSession = vi.mocked(createAgentSession);

beforeEach(() => {
	vi.restoreAllMocks();
});

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

describe("runSubAgent", () => {
	const makeTemplate = (overrides?: Partial<Parameters<typeof runSubAgent>[0]["template"]>) => ({
		name: "test-agent",
		category: "test",
		description: "test",
		model: "inherit" as const,
		thinkingLevel: "medium" as const,
		tools: ["read", "bash"],
		systemPrompt: "You are a test agent.",
		...overrides,
	});

	function mockSession(opts: {
		messages?: Array<{ role: string; content: unknown }>;
		promptBehavior?: "resolve" | "hang" | "reject";
		promptError?: Error;
	} = {}) {
		const subscribers: Array<(event: any) => void> = [];
		// For "hang" behavior: prompt resolves when abort() is called
		let resolveHang: (() => void) | null = null;
		const session = {
			agent: { setSystemPrompt: vi.fn() },
			prompt: vi.fn(),
			messages: opts.messages ?? [{ role: "assistant", content: "test output" }],
			dispose: vi.fn(),
			abort: vi.fn(() => { resolveHang?.(); }),
			setActiveToolsByName: vi.fn(),
			subscribe: vi.fn((cb: (event: any) => void) => {
				subscribers.push(cb);
				return () => { /* unsub */ };
			}),
		};

		if (opts.promptBehavior === "hang") {
			session.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolveHang = resolve; }));
		} else if (opts.promptBehavior === "reject") {
			session.prompt.mockRejectedValue(opts.promptError ?? new Error("prompt failed"));
		} else {
			session.prompt.mockResolvedValue(undefined);
		}

		mockCreateSession.mockResolvedValue({
			session: session as any,
			extensionsResult: { extensions: [], errors: [], runtime: 0 as any },
		});

		return { session, subscribers, emit: (event: any) => subscribers.forEach(cb => cb(event)) };
	}

	it("returns timeout error when sub-agent exceeds timeout", async () => {
		vi.useFakeTimers();
		const { session } = mockSession({ promptBehavior: "hang" });

		const resultPromise = runSubAgent({
			template: makeTemplate(),
			task: "do something slow",
			cwd: "/tmp",
			parentModel: undefined,
			customTools: [],
			hasLsp: false,
			timeout: 100,
		});

		// Advance past timeout
		await vi.advanceTimersByTimeAsync(150);

		const result = await resultPromise;

		expect(result.error).toContain("timed out");
		expect(result.error).toContain("100ms");
		expect(session.abort).toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("does not set timeout when timeout=0", async () => {
		vi.useFakeTimers();
		const { session } = mockSession();

		const result = await runSubAgent({
			template: makeTemplate(),
			task: "quick task",
			cwd: "/tmp",
			parentModel: undefined,
			customTools: [],
			hasLsp: false,
			timeout: 0,
		});

		expect(result.output).toBe("test output");
		expect(result.error).toBeUndefined();
		expect(session.abort).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("streams message_update progress with truncation", async () => {
		const { session, emit } = mockSession();
		const progress: string[] = [];

		// Start the agent — prompt resolves synchronously after subscribers are set up
		// We need to capture progress during execution, so mock prompt to emit events first
		session.prompt.mockImplementation(async () => {
			emit({ type: "message_update", text: "Short finding" });
			emit({ type: "message_update", text: "A".repeat(200) });
		});

		await runSubAgent({
			template: makeTemplate(),
			task: "explore code",
			cwd: "/tmp",
			parentModel: undefined,
			customTools: [],
			hasLsp: false,
			onProgress: (s) => progress.push(s),
		});

		const messageUpdates = progress.filter(p => p.startsWith("finding:"));
		expect(messageUpdates).toHaveLength(2);
		expect(messageUpdates[0]).toBe("finding: Short finding");
		// Second should be truncated to ~120 chars + ellipsis
		expect(messageUpdates[1]).toContain("finding: ");
		expect(messageUpdates[1].length).toBeLessThan(140);
		expect(messageUpdates[1]).toContain("…");
	});

	it("streams tool_execution_start and tool_execution_end progress", async () => {
		const { session, emit } = mockSession();
		const progress: string[] = [];

		session.prompt.mockImplementation(async () => {
			emit({ type: "tool_execution_start", toolName: "read" });
			emit({ type: "tool_execution_end", toolName: "read" });
		});

		await runSubAgent({
			template: makeTemplate(),
			task: "explore",
			cwd: "/tmp",
			parentModel: undefined,
			customTools: [],
			hasLsp: false,
			onProgress: (s) => progress.push(s),
		});

		expect(progress).toContain("tool 1: read");
		expect(progress).toContain("tool 1: read done");
	});

	it("disposes session on error", async () => {
		const { session } = mockSession({ promptBehavior: "reject", promptError: new Error("boom") });

		const result = await runSubAgent({
			template: makeTemplate(),
			task: "crash",
			cwd: "/tmp",
			parentModel: undefined,
			customTools: [],
			hasLsp: false,
		});

		expect(result.error).toContain("boom");
		expect(session.dispose).toHaveBeenCalled();
	});
});
