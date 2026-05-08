import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFetchTool } from "../../src/web/tool.js";

// Mock fetch and summarizer
vi.mock("../../src/web/fetch.js", () => ({
	fetchUrl: vi.fn(),
}));

vi.mock("../../src/web/summarizer.js", () => ({
	summarizeContent: vi.fn(),
}));

import { fetchUrl } from "../../src/web/fetch.js";
import { summarizeContent } from "../../src/web/summarizer.js";

const mockFetchUrl = vi.mocked(fetchUrl);
const mockSummarize = vi.mocked(summarizeContent);

beforeEach(() => {
	vi.resetAllMocks();
});

function makeCtx(model?: unknown) {
	return { model } as any;
}

describe("createFetchTool", () => {
	it("returns a tool with the correct name and schema", () => {
		const tool = createFetchTool("/tmp");
		expect(tool.name).toBe("fetch");
		expect(tool.parameters).toBeDefined();
	});

	it("fetches URL, summarizes, and returns content", async () => {
		mockFetchUrl.mockResolvedValueOnce({
			content: "# Hello World",
			contentType: "text/html",
			truncated: false,
		});
		mockSummarize.mockResolvedValueOnce("Summarized result");

		const tool = createFetchTool("/my/cwd");
		const onUpdate = vi.fn();
		const result = await tool.execute(
			"call-1",
			{ url: "https://example.com", prompt: "What is this?" },
			undefined,
			onUpdate,
			makeCtx("test-model"),
		);

		expect(result.content).toEqual([{ type: "text", text: "Summarized result" }]);
	});

	it("passes signal through to fetchUrl", async () => {
		mockFetchUrl.mockResolvedValueOnce({
			content: "content",
			contentType: "text/plain",
			truncated: false,
		});
		mockSummarize.mockResolvedValueOnce("content");

		const tool = createFetchTool("/tmp");
		const signal = new AbortController().signal;
		await tool.execute(
			"call-2",
			{ url: "https://example.com", prompt: "info" },
			signal,
			undefined,
			makeCtx(),
		);

		expect(mockFetchUrl).toHaveBeenCalledWith("https://example.com", signal);
	});

	it("passes cwd, model, and signal to summarizeContent", async () => {
		mockFetchUrl.mockResolvedValueOnce({
			content: "fetched content",
			contentType: "text/html",
			truncated: false,
		});
		mockSummarize.mockResolvedValueOnce("summary");

		const tool = createFetchTool("/my/project");
		const signal = new AbortController().signal;
		const model = { id: "test-model" };
		await tool.execute(
			"call-3",
			{ url: "https://example.com", prompt: "extract info" },
			signal,
			undefined,
			makeCtx(model),
		);

		expect(mockSummarize).toHaveBeenCalledWith({
			content: "fetched content",
			prompt: "extract info",
			cwd: "/my/project",
			model,
			signal,
		});
	});

	it("calls onUpdate with progress messages", async () => {
		mockFetchUrl.mockResolvedValueOnce({
			content: "content",
			contentType: "text/html",
			truncated: false,
		});
		mockSummarize.mockResolvedValueOnce("summary");

		const tool = createFetchTool("/tmp");
		const onUpdate = vi.fn();
		await tool.execute(
			"call-4",
			{ url: "https://example.com/docs", prompt: "info" },
			undefined,
			onUpdate,
			makeCtx(),
		);

		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(onUpdate.mock.calls[0][0].content[0].text).toContain("Fetching");
		expect(onUpdate.mock.calls[1][0].content[0].text).toContain("Fetched");
	});

	it("propagates fetchUrl errors", async () => {
		mockFetchUrl.mockRejectedValueOnce(new Error("Network error"));

		const tool = createFetchTool("/tmp");
		await expect(
			tool.execute("call-5", { url: "https://bad.com", prompt: "info" }, undefined, undefined, makeCtx()),
		).rejects.toThrow("Network error");
	});
});
