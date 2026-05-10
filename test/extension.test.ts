import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
	const lspManager = {
		warmup: vi.fn(),
		release: vi.fn(),
		getClientForFile: vi.fn(),
		syncFile: vi.fn(),
	};
	return {
		requireRtk: vi.fn(),
		rtkSpawnHook: vi.fn(),
		loadCodeIntelConfig: vi.fn(),
		loadLspConfig: vi.fn(),
		registerCommands: vi.fn(),
		buildSystemPrompt: vi.fn(),
		installSystemPromptCapture: vi.fn(),
		createBashTool: vi.fn(),
		createLspTool: vi.fn(),
		createFetchTool: vi.fn(),
		createContext7Tool: vi.fn(),
		createAgentTool: vi.fn(),
		isEditToolResult: vi.fn(),
		isWriteToolResult: vi.fn(),
		isInSubAgent: vi.fn(),
		lspManager,
		acquireLspManager: vi.fn(),
	};
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
	createBashTool: mocks.createBashTool,
	isEditToolResult: mocks.isEditToolResult,
	isWriteToolResult: mocks.isWriteToolResult,
}));

vi.mock("../src/rtk.js", () => ({
	requireRtk: mocks.requireRtk,
	rtkSpawnHook: mocks.rtkSpawnHook,
}));
vi.mock("../src/config.js", () => ({
	loadCodeIntelConfig: mocks.loadCodeIntelConfig,
}));
vi.mock("../src/lsp/config.js", () => ({
	loadLspConfig: mocks.loadLspConfig,
}));
vi.mock("../src/lsp/client.js", () => ({
	LspClientManager: { acquire: mocks.acquireLspManager },
}));
vi.mock("../src/lsp/tool.js", () => ({
	createLspTool: mocks.createLspTool,
}));
vi.mock("../src/agents/tool.js", () => ({
	createAgentTool: mocks.createAgentTool,
}));
vi.mock("../src/agents/runner.js", () => ({
	isInSubAgent: mocks.isInSubAgent,
}));
vi.mock("../src/commands/registry.js", () => ({
	registerCommands: mocks.registerCommands,
}));
vi.mock("../src/prompt/system-prompt.js", () => ({
	buildSystemPrompt: mocks.buildSystemPrompt,
}));
vi.mock("../src/analysis/capture.js", () => ({
	installSystemPromptCapture: mocks.installSystemPromptCapture,
}));
vi.mock("../src/web/tool.js", () => ({
	createFetchTool: mocks.createFetchTool,
}));
vi.mock("../src/web/context7.js", () => ({
	createContext7Tool: mocks.createContext7Tool,
}));

const { default: piCodeIntel } = await import("../src/extension.js");

interface FakePi {
	registerTool: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	getAllTools: ReturnType<typeof vi.fn>;
}

function defaultConfig() {
	return {
		lsp: { enabled: true },
		agents: { enabled: true },
		prompt: { enabled: true },
		web: { enabled: true },
		context7: { enabled: true },
		analysis: { captureSystemPrompt: true },
	};
}

function createFakePi(): FakePi {
	const handlers = new Map<string, Array<(event?: unknown) => unknown>>();
	return {
		registerTool: vi.fn(),
		on: vi.fn((name: string, handler: (event?: unknown) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		}),
		getActiveTools: vi.fn(() => ["read", "grep", "find", "bash", "lsp"]),
		setActiveTools: vi.fn(),
		getAllTools: vi.fn(() => [
			{ name: "read", description: "Read files\nMore details" },
			{ name: "lsp", description: "Language intelligence" },
		]),
	};
}

function handlers(pi: FakePi, event: string): Array<(event?: unknown) => unknown> {
	return pi.on.mock.calls
		.filter(([name]) => name === event)
		.map(([, handler]) => handler as (event?: unknown) => unknown);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadCodeIntelConfig.mockReturnValue(defaultConfig());
	mocks.loadLspConfig.mockReturnValue({});
	mocks.lspManager.warmup.mockResolvedValue(undefined);
	mocks.lspManager.release.mockResolvedValue(undefined);
	mocks.lspManager.getClientForFile.mockResolvedValue({ id: "client" });
	mocks.lspManager.syncFile.mockResolvedValue(undefined);
	mocks.acquireLspManager.mockReturnValue(mocks.lspManager);
	mocks.createBashTool.mockReturnValue({ name: "bash" });
	mocks.createLspTool.mockReturnValue({ name: "lsp" });
	mocks.createFetchTool.mockReturnValue({ name: "fetch" });
	mocks.createContext7Tool.mockReturnValue({
		tool: { name: "context7" },
		client: { stop: vi.fn() },
	});
	mocks.createAgentTool.mockReturnValue({ name: "agent" });
	mocks.buildSystemPrompt.mockReturnValue("rewritten prompt");
	mocks.isEditToolResult.mockReturnValue(false);
	mocks.isWriteToolResult.mockReturnValue(false);
	mocks.isInSubAgent.mockReturnValue(false);
});

describe("piCodeIntel extension entry", () => {
	it("registers enabled tools, commands, prompt hooks, and system prompt capture", () => {
		const pi = createFakePi();

		piCodeIntel(pi as never);

		expect(mocks.requireRtk).toHaveBeenCalledOnce();
		expect(mocks.registerCommands).toHaveBeenCalledWith(pi);
		expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
			"bash",
			"lsp",
			"fetch",
			"context7",
			"agent",
		]);
		expect(mocks.createAgentTool).toHaveBeenCalledWith(
			[{ name: "lsp" }, { name: "fetch" }, { name: "context7" }],
			true,
		);
		expect(mocks.installSystemPromptCapture).toHaveBeenCalledWith(pi);
		expect(handlers(pi, "before_agent_start")).toHaveLength(2);
	});

	it("removes grep/find/ls once before agent start and rewrites the prompt", () => {
		const pi = createFakePi();
		pi.getActiveTools.mockReturnValue(["read", "grep", "find", "ls", "bash"]);

		piCodeIntel(pi as never);
		const beforeStart = handlers(pi, "before_agent_start");

		beforeStart[0]({});
		beforeStart[0]({});
		const promptPatch = beforeStart[1]({ systemPrompt: "base prompt" });

		expect(pi.setActiveTools).toHaveBeenCalledTimes(1);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
		expect(mocks.buildSystemPrompt).toHaveBeenCalledWith({
			activeTools: ["read", "grep", "find", "ls", "bash"],
			toolSnippets: {
				read: "Read files",
				lsp: "Language intelligence",
			},
			piSystemPrompt: "base prompt",
		});
		expect(promptPatch).toEqual({ systemPrompt: "rewritten prompt" });
	});

	it("does not register the agent tool inside a sub-agent session", () => {
		mocks.isInSubAgent.mockReturnValue(true);
		const pi = createFakePi();

		piCodeIntel(pi as never);

		expect(mocks.createAgentTool).not.toHaveBeenCalled();
		expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).not.toContain("agent");
	});

	it("syncs edited and written files with LSP after successful tool results", async () => {
		const pi = createFakePi();
		const editResult = { isError: false, input: { path: "src/file.ts" } };
		mocks.isEditToolResult.mockImplementation((event) => event === editResult);

		piCodeIntel(pi as never);
		const [toolResultHandler] = handlers(pi, "tool_result");
		toolResultHandler(editResult);
		await vi.waitFor(() => {
			expect(mocks.lspManager.syncFile).toHaveBeenCalledWith(
				{ id: "client" },
				expect.stringContaining("src/file.ts"),
			);
		});
	});

	it("runs registered cleanup functions on session shutdown", async () => {
		const pi = createFakePi();
		const context7Client = { stop: vi.fn() };
		mocks.createContext7Tool.mockReturnValue({
			tool: { name: "context7" },
			client: context7Client,
		});

		piCodeIntel(pi as never);
		const [shutdown] = handlers(pi, "session_shutdown");
		await shutdown({});

		expect(mocks.lspManager.release).toHaveBeenCalledOnce();
		expect(context7Client.stop).toHaveBeenCalledOnce();
	});
});
