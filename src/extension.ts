import { resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
	createBashTool,
	isEditToolResult,
	isWriteToolResult,
} from "@mariozechner/pi-coding-agent";
import { installSystemPromptCapture } from "./analysis/capture.js";
import { loadCodeIntelConfig } from "./config.js";
import { loadLspConfig } from "./lsp/config.js";
import { LspClientManager } from "./lsp/client.js";
import { createLspTool } from "./lsp/tool.js";
import { createAgentTool } from "./agents/tool.js";
import { isInSubAgent } from "./agents/runner.js";
import { registerCommands } from "./commands/registry.js";
import { buildSystemPrompt } from "./prompt/system-prompt.js";
import { requireRtk, rtkSpawnHook } from "./rtk.js";
import { createFetchTool } from "./web/tool.js";
import { createContext7Tool, type Context7Client } from "./web/context7.js";

/**
 * Pi extension entry point.
 *
 * Registers LSP, web fetch, Context7, and sub-agent tools,
 * plus the code intelligence system prompt workflow.
 * All bash commands are routed through RTK for token-optimized output.
 */
const piCodeIntel: ExtensionFactory = (pi: ExtensionAPI): void => {
	// RTK is mandatory — fail early with install instructions
	requireRtk();

	const cwd = process.cwd();
	const config = loadCodeIntelConfig(cwd);
	const cleanupFns: Array<() => Promise<void>> = [];
	const isSubAgent = isInSubAgent();

	// 0. Register slash commands eagerly so they appear in autocomplete at startup.
	const hasAgents = config.agents.enabled;
	if (hasAgents) {
		registerCommands(pi);
	}

	// Defer action-method calls (setActiveTools) to runtime.
	// Pi does not allow action methods during extension loading — only registration
	// methods (registerTool, registerCommand, on) are permitted in the factory.

	// One-time runtime init: remove grep/find/ls from active tools.
	// RTK-wrapped bash provides the same functionality with token-optimized output.
	let runtimeInitDone = false;
	pi.on("before_agent_start", () => {
		if (runtimeInitDone) return;
		runtimeInitDone = true;
		const piAny = pi as any;
		if (
			typeof piAny.getActiveTools === "function" &&
			typeof piAny.setActiveTools === "function"
		) {
			const active: string[] = piAny.getActiveTools();
			const hidden = new Set(["grep", "find", "ls"]);
			const filtered = active.filter((t) => !hidden.has(t));
			if (filtered.length !== active.length) {
				piAny.setActiveTools(filtered);
			}
		} else {
			console.error(
				"[code-intel] SDK does not support getActiveTools/setActiveTools — grep/find/ls tools remain active alongside bash",
			);
		}
	});

	// System prompt — fully replace pi's default on every agent start
	if (config.prompt.enabled) {
		pi.on("before_agent_start", (event) => {
			const activeToolNames = pi.getActiveTools();
			const allToolInfo = pi.getAllTools();

			const toolSnippets: Record<string, string> = {};
			for (const tool of allToolInfo) {
				if (tool.description) {
					toolSnippets[tool.name] = tool.description.split("\n")[0];
				}
			}

			return {
				systemPrompt: buildSystemPrompt({
					activeTools: activeToolNames,
					toolSnippets,
					piSystemPrompt: event.systemPrompt ?? "",
				}),
			};
		});
	}

	// System-prompt capture for the analyze-sessions tool. Registered AFTER
	// our own rewriter (above) so the captured text reflects the prompt as
	// it has been chained through our own modifications, which is what the
	// LLM sees at this handler position.
	//
	// Limitation, recorded honestly: other extensions registered AFTER ours
	// can still mutate `systemPrompt` between this capture and the provider
	// request. In practice no other extension does this in the
	// pi-code-intel setup, so the captured text matches what the LLM saw.
	if (config.analysis.captureSystemPrompt) {
		installSystemPromptCapture(pi);
	}

	// 1. RTK-wrapped bash tool — overrides Pi's built-in bash with RTK rewriting
	pi.registerTool(createBashTool(cwd, { spawnHook: rtkSpawnHook }));

	// 2. LSP subsystem
	let lspManager: LspClientManager | null = null;
	let lspTool = null;
	if (config.lsp.enabled) {
		const lspConfig = loadLspConfig(cwd);
		lspManager = LspClientManager.getInstance(lspConfig, cwd);
		lspTool = createLspTool(lspManager, cwd);
		pi.registerTool(lspTool);
		cleanupFns.push(() => lspManager!.release());
		// Start detected servers in background so they can index the workspace
		lspManager.warmup().catch((err) => {
			console.error(
				"[code-intel] LSP warmup failed:",
				err instanceof Error ? err.message : err,
			);
		});
	}

	// 3. Web fetch tool
	let fetchTool = null;
	if (config.web.enabled) {
		fetchTool = createFetchTool(cwd);
		pi.registerTool(fetchTool);
	}

	// 4. Context7 library docs tool
	let context7Client: Context7Client | null = null;
	let context7Tool: ToolDefinition | null = null;
	if (config.context7.enabled) {
		const context7Result = createContext7Tool();
		context7Tool = context7Result.tool as unknown as ToolDefinition;
		pi.registerTool(context7Result.tool);
		context7Client = context7Result.client;
		cleanupFns.push(async () => context7Client!.stop());
	}

	// 5. Sub-agent subsystem
	// Skip agent tool registration inside sub-agent sessions — createAgentSession
	// loads extensions by default, and we don't want sub-agents spawning nested agents.
	if (config.agents.enabled && !isSubAgent) {
		// Pass custom tool definitions so sub-agents can access them via
		// createAgentSession. Each shared tool wraps parent-owned state
		// (LSP manager, MCP client) whose lifecycle this extension already
		// manages — sub-agents reuse the instance and never tear it down.
		// Sub-agent templates filter this list by name (see runner.ts), so a
		// tool only becomes available when a template explicitly lists it.
		const registeredCustomTools: ToolDefinition[] = [];
		if (lspTool) {
			registeredCustomTools.push(lspTool as unknown as ToolDefinition);
		}
		if (fetchTool) {
			registeredCustomTools.push(fetchTool as unknown as ToolDefinition);
		}
		if (context7Tool) {
			registeredCustomTools.push(context7Tool);
		}
		const agentTool = createAgentTool(registeredCustomTools);
		pi.registerTool(agentTool);
	}

	// 6. Format-on-write: sync files with LSP after edit/write operations
	if (lspManager) {
		const manager = lspManager;

		async function syncFileWithLsp(filePath: string): Promise<void> {
			const absPath = resolve(filePath);
			const client = await manager.getClientForFile(absPath);
			if (client) {
				await manager.syncFile(client, absPath);
			}
		}

		pi.on("tool_result", (event) => {
			if (event.isError) return;

			let filePath: string | undefined;
			if (isEditToolResult(event)) {
				filePath = (event.input as { path?: string }).path;
			} else if (isWriteToolResult(event)) {
				filePath = (event.input as { path?: string }).path;
			}

			if (filePath) {
				syncFileWithLsp(filePath).catch((err) => {
					console.error(
						`[lsp] Failed to sync ${filePath} with LSP after edit:`,
						err instanceof Error ? err.message : err,
					);
				});
			}
		});
	}

	// 7. Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		await Promise.allSettled(cleanupFns.map((fn) => fn()));
	});
};

export default piCodeIntel;
