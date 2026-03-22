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
import { isInSubAgent } from "./agents/runner.js";
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

	// 0. Register slash commands eagerly so they appear in autocomplete at startup.
	const hasAgents = config.agents.enabled;
	if (hasAgents) {
		registerCommands(pi);
	}

	// Defer action-method calls (setActiveTools) to runtime.
	// Pi does not allow action methods during extension loading — only registration
	// methods (registerTool, registerCommand, on) are permitted in the factory.
	let runtimeInitDone = false;
	pi.on("before_agent_start", () => {
		if (runtimeInitDone) return;
		runtimeInitDone = true;

		// Ensure grep, find, ls are active (pi defaults to read/bash/edit/write only)
		const piAny = pi as any;
		if (
			typeof piAny.getActiveTools === "function" &&
			typeof piAny.setActiveTools === "function"
		) {
			const active: string[] = piAny.getActiveTools();
			const needed = ["grep", "find", "ls"];
			const missing = needed.filter((t) => !active.includes(t));
			if (missing.length > 0) {
				piAny.setActiveTools([...active, ...missing]);
			}
		}
	});

	// 1. LSP subsystem
	let lspManager: LspClientManager | null = null;
	if (config.lsp.enabled) {
		const lspConfig = loadLspConfig(cwd);
		lspManager = LspClientManager.getInstance(lspConfig, cwd);
		const lspTool = createLspTool(lspManager, cwd);
		pi.registerTool(lspTool);
		cleanupFns.push(() => lspManager!.shutdown());
		// Start detected servers in background so they can index the workspace
		lspManager.warmup().catch((err) => {
			console.error(
				"[code-intel] LSP warmup failed:",
				err instanceof Error ? err.message : err,
			);
		});
	}

	// 2. Semantic search subsystem
	if (config.search.enabled) {
		const semvex = new SemvexProcess(
			cwd,
			config.search.command,
			config.search.args,
		);
		const [searchCodeTool, searchDocsTool] = createSearchTools(semvex);
		pi.registerTool(searchCodeTool);
		pi.registerTool(searchDocsTool);
		cleanupFns.push(() => semvex.shutdown());
	}

	// 3. Sub-agent subsystem
	// Skip agent tool registration inside sub-agent sessions — createAgentSession
	// loads extensions by default, and we don't want sub-agents spawning nested agents.
	if (config.agents.enabled && !isInSubAgent()) {
		// Pass custom tool definitions so sub-agents can access them via createAgentSession
		const registeredCustomTools: ToolDefinition[] = [];
		// Re-create tools for sub-agent injection (they need fresh instances)
		if (config.lsp.enabled && lspManager) {
			registeredCustomTools.push(
				createLspTool(lspManager, cwd) as unknown as ToolDefinition,
			);
		}
		if (config.search.enabled) {
			const semvexForAgents = new SemvexProcess(
				cwd,
				config.search.command,
				config.search.args,
			);
			const [sc, sd] = createSearchTools(semvexForAgents);
			registeredCustomTools.push(sc as unknown as ToolDefinition);
			registeredCustomTools.push(sd as unknown as ToolDefinition);
			cleanupFns.push(() => semvexForAgents.shutdown());
		}
		const agentTool = createAgentTool(registeredCustomTools);
		pi.registerTool(agentTool);
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
							manager.syncFile(client, filePath!).catch((err) => {
								console.error(
									`[lsp] Failed to sync file ${filePath} after edit:`,
									err instanceof Error ? err.message : err,
								);
							});
						}
					})
					.catch((err) => {
						console.error(
							`[lsp] Failed to sync file ${filePath} after edit:`,
							err instanceof Error ? err.message : err,
						);
					});
			}
		});
	}

	// 6. Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		await Promise.allSettled(cleanupFns.map((fn) => fn()));
	});
};

export default piCodeIntel;
