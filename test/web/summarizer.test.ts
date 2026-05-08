import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildExtractionPrompt, summarizeContent } from "../../src/web/summarizer.js";

// Mock createAgentSession
vi.mock("@mariozechner/pi-coding-agent", () => ({
	SessionManager: {
		inMemory: vi.fn(() => ({})),
	},
	createAgentSession: vi.fn(),
}));

import { createAgentSession } from "@mariozechner/pi-coding-agent";
const mockCreateSession = vi.mocked(createAgentSession);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("buildExtractionPrompt", () => {
	it("assembles content and prompt in CC format", () => {
		const result = buildExtractionPrompt("# Hello\nWorld", "What does this page describe?");

		expect(result).toContain("Web page content:");
		expect(result).toContain("---\n# Hello\nWorld\n---");
		expect(result).toContain("What does this page describe?");
		expect(result).toContain("Provide a concise response based on the content above");
	});
});

describe("summarizeContent", () => {
	it("returns small content directly without model call", async () => {
		const content = "Short content";

		const result = await summarizeContent({
			content,
			prompt: "extract info",
			cwd: "/tmp",
		});

		expect(result).toBe("Short content");
		expect(mockCreateSession).not.toHaveBeenCalled();
	});

	it("calls model for large content", async () => {
		const largeContent = "x".repeat(40_000);
		const mockSession = {
			agent: { setSystemPrompt: vi.fn() },
			prompt: vi.fn(),
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Summarized content here" }],
				},
			],
			dispose: vi.fn(),
			abort: vi.fn(),
		};
		mockCreateSession.mockResolvedValueOnce({
			session: mockSession as any,
			extensionsResult: { extensions: [], errors: [], runtime: 0 as any },
		});

		const result = await summarizeContent({
			content: largeContent,
			prompt: "What is this about?",
			cwd: "/tmp",
		});

		expect(result).toBe("Summarized content here");
		expect(mockCreateSession).toHaveBeenCalledOnce();
		expect(mockSession.agent.setSystemPrompt).toHaveBeenCalledWith("");
		expect(mockSession.prompt).toHaveBeenCalledWith(
			expect.stringContaining("What is this about?"),
		);
		expect(mockSession.dispose).toHaveBeenCalled();
	});

	it("disposes session even on error", async () => {
		const largeContent = "x".repeat(40_000);
		const mockSession = {
			agent: { setSystemPrompt: vi.fn() },
			prompt: vi.fn().mockRejectedValueOnce(new Error("model error")),
			messages: [],
			dispose: vi.fn(),
			abort: vi.fn(),
		};
		mockCreateSession.mockResolvedValueOnce({
			session: mockSession as any,
			extensionsResult: { extensions: [], errors: [], runtime: 0 as any },
		});

		await expect(
			summarizeContent({
				content: largeContent,
				prompt: "extract",
				cwd: "/tmp",
			}),
		).rejects.toThrow("model error");

		expect(mockSession.dispose).toHaveBeenCalled();
	});

	it("throws immediately if signal is already aborted (no createAgentSession)", async () => {
		const largeContent = "x".repeat(40_000);
		const controller = new AbortController();
		controller.abort();

		await expect(
			summarizeContent({
				content: largeContent,
				prompt: "extract",
				cwd: "/tmp",
				signal: controller.signal,
			}),
		).rejects.toThrow(/aborted/);

		expect(mockCreateSession).not.toHaveBeenCalled();
	});

	it("swallows session.abort() rejections so a fired abort cannot crash the process", async () => {
		const largeContent = "x".repeat(40_000);
		// `prompt()` never resolves on its own; only the abort handler can end it.
		let rejectPrompt: ((err: Error) => void) | undefined;
		const mockSession = {
			agent: { setSystemPrompt: vi.fn() },
			prompt: vi.fn(
				() => new Promise<void>((_, reject) => {
					rejectPrompt = reject;
				}),
			),
			messages: [],
			dispose: vi.fn(),
			// session.abort() returns a Promise that rejects — if the summarizer's
			// abort handler did not catch it, this would become an unhandled
			// rejection. Also drives the prompt rejection so the outer promise can
			// settle.
			abort: vi.fn(() => {
				rejectPrompt?.(new Error("prompt aborted"));
				return Promise.reject(new Error("abort failed internally"));
			}),
		};
		mockCreateSession.mockResolvedValueOnce({
			session: mockSession as any,
			extensionsResult: { extensions: [], errors: [], runtime: 0 as any },
		});

		const controller = new AbortController();
		const pending = summarizeContent({
			content: largeContent,
			prompt: "extract",
			cwd: "/tmp",
			signal: controller.signal,
		});

		// Defer the abort past both pre- and post-creation guards so it can
		// only land via the abort listener (which is what we want to test).
		await new Promise((r) => setImmediate(r));
		controller.abort();

		await expect(pending).rejects.toThrow("prompt aborted");
		expect(mockSession.abort).toHaveBeenCalled();
		expect(mockSession.dispose).toHaveBeenCalled();
	});

	it("returns fallback when model produces no text", async () => {
		const largeContent = "x".repeat(40_000);
		const mockSession = {
			agent: { setSystemPrompt: vi.fn() },
			prompt: vi.fn(),
			messages: [{ role: "assistant", content: [] }],
			dispose: vi.fn(),
			abort: vi.fn(),
		};
		mockCreateSession.mockResolvedValueOnce({
			session: mockSession as any,
			extensionsResult: { extensions: [], errors: [], runtime: 0 as any },
		});

		const result = await summarizeContent({
			content: largeContent,
			prompt: "extract",
			cwd: "/tmp",
		});

		expect(result).toContain("[Content summarization produced no output");
	});
});
