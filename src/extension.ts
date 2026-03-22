import {
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
	isEditToolResult,
	isWriteToolResult,
} from "@mariozechner/pi-coding-agent";
import { loadCodeIntelConfig } from "./config.js";
import { loadLspConfig } from "./lsp/config.js";
import { LspClientManager } from "./lsp/client.js";
import { createLspTool } from "./lsp/tool.js";
import { createAgentTool } from "./agents/tool.js";
import { registerCommands } from "./commands/registry.js";
import { createSearchTools } from "./search/tool.js";
import { SemvexProcess } from "./search/process.js";
import { buildSystemPrompt } from "./prompt/system-prompt.js";

/**
 * Pi extension entry point.
 *
 * Registers LSP, sub-agent, and semantic search tools,
 * plus the code intelligence system prompt workflow.
 */
const piCodeIntel: ExtensionFactory = (pi: ExtensionAPI): void => {
	const cwd = process.cwd();
	const config = loadCodeIntelConfig(cwd);
	const cleanupFns: Array<() => Promise<void>> = [];

	// 0. Ensure grep, find, ls are active (pi defaults to read/bash/edit/write only)
	const piAny = pi as any;
	if (typeof piAny.getActiveTools === "function" && typeof piAny.setActiveTools === "function") {
		const active: string[] = piAny.getActiveTools();
		const needed = ["grep", "find", "ls"];
		const missing = needed.filter((t) => !active.includes(t));
		if (missing.length > 0) {
			piAny.setActiveTools([...active, ...missing]);
		}
	}

	// 1. LSP subsystem
	let lspManager: LspClientManager | null = null;
	if (config.lsp.enabled) {
		const lspConfig = loadLspConfig(cwd);
		lspManager = new LspClientManager(lspConfig, cwd);
		const lspTool = createLspTool(lspManager, cwd);
		pi.registerTool(lspTool);
		cleanupFns.push(() => lspManager!.shutdown());
		// Start detected servers in background so they can index the workspace
		lspManager.warmup().catch(() => {});
	}

	// 2. Semantic search subsystem
	if (config.search.enabled) {
		const semvex = new SemvexProcess(cwd, config.search.command, config.search.args);
		const [searchCodeTool, searchDocsTool] = createSearchTools(semvex);
		pi.registerTool(searchCodeTool);
		pi.registerTool(searchDocsTool);
		cleanupFns.push(() => semvex.shutdown());
	}

	// 3. Sub-agent subsystem
	if (config.agents.enabled) {
		// Pass custom tool definitions so sub-agents can access them via createAgentSession
		const registeredCustomTools: ToolDefinition[] = [];
		// Re-create tools for sub-agent injection (they need fresh instances)
		if (config.lsp.enabled && lspManager) {
			registeredCustomTools.push(
				createLspTool(lspManager, cwd) as unknown as ToolDefinition,
			);
		}
		if (config.search.enabled) {
			const semvexForAgents = new SemvexProcess(cwd, config.search.command, config.search.args);
			const [sc, sd] = createSearchTools(semvexForAgents);
			registeredCustomTools.push(sc as unknown as ToolDefinition);
			registeredCustomTools.push(sd as unknown as ToolDefinition);
			cleanupFns.push(() => semvexForAgents.shutdown());
		}
		const agentTool = createAgentTool(registeredCustomTools);
		pi.registerTool(agentTool);

		// Register slash commands that orchestrate sub-agents
		registerCommands(pi);
	}

	// 4. System prompt — fully replace pi's default
	if (config.prompt.enabled) {
		pi.on("before_agent_start", (event) => {
			const activeToolNames = pi.getActiveTools();

			// Collect tool snippets from registered tools
			const allToolInfo = pi.getAllTools();
			const toolSnippets: Record<string, string> = {};
			for (const tool of allToolInfo) {
				if (tool.description) {
					// Use first line of description as snippet
					toolSnippets[tool.name] = tool.description.split("\n")[0];
				}
			}

			return {
				systemPrompt: buildSystemPrompt({
					hasLsp: activeToolNames.includes("lsp"),
					hasSearch: activeToolNames.includes("search_code"),
					hasAgent: activeToolNames.includes("agent"),
					activeTools: activeToolNames,
					toolSnippets,
					piSystemPrompt: event.systemPrompt ?? "",
				}),
			};
		});
	}

	// 5. Format-on-write: sync files with LSP after edit/write operations
	if (lspManager) {
		const manager = lspManager;
		pi.on("tool_result", (event) => {
			if (event.isError) return;

			let filePath: string | undefined;
			if (isEditToolResult(event)) {
				filePath = (event.input as { path?: string }).path;
			} else if (isWriteToolResult(event)) {
				filePath = (event.input as { path?: string }).path;
			}

			if (filePath) {
				manager
					.getClientForFile(filePath)
					.then((client) => {
						if (client) {
							manager.syncFile(client, filePath!).catch(() => {});
						}
					})
					.catch(() => {});
			}
		});
	}

	// 6. Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		await Promise.allSettled(cleanupFns.map((fn) => fn()));
	});
};

export default piCodeIntel;
