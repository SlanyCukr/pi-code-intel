import {
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
	isEditToolResult,
	isWriteToolResult,
} from "@mariozechner/pi-coding-agent";
import { loadLspConfig } from "./lsp/config.js";
import { LspClientManager } from "./lsp/client.js";
import { createLspTool } from "./lsp/tool.js";
import { createAgentTool } from "./agents/tool.js";
import { createSearchTools } from "./search/tool.js";
import { SemvexProcess } from "./search/process.js";
import { buildCodeIntelPrompt } from "./prompt/system-prompt.js";

/**
 * Pi extension entry point.
 *
 * Registers LSP, sub-agent, and semantic search tools,
 * plus the code intelligence system prompt workflow.
 */
const piCodeIntel: ExtensionFactory = (pi: ExtensionAPI): void => {
	const cwd = process.cwd();

	// 1. LSP subsystem
	const lspConfig = loadLspConfig(cwd);
	const lspManager = new LspClientManager(lspConfig, cwd);
	const lspTool = createLspTool(lspManager, cwd);
	pi.registerTool(lspTool);

	// 2. Semantic search subsystem
	const semvex = new SemvexProcess(cwd);
	const [searchCodeTool, searchDocsTool] = createSearchTools(semvex);
	pi.registerTool(searchCodeTool);
	pi.registerTool(searchDocsTool);

	// 3. Sub-agent subsystem
	// Collect all custom tools registered so sub-agents can access them
	// ToolDefinition generic variance requires casting for mixed schema types
	const customTools = [
		lspTool,
		searchCodeTool,
		searchDocsTool,
	] as unknown as ToolDefinition[];
	const agentTool = createAgentTool(customTools);
	pi.registerTool(agentTool);

	// 4. System prompt injection
	pi.on("before_agent_start", (event) => {
		const activeToolNames = pi.getActiveTools();

		const prompt = buildCodeIntelPrompt({
			hasLsp: activeToolNames.includes("lsp"),
			hasSearch: activeToolNames.includes("search_code"),
			hasAgent: activeToolNames.includes("agent"),
		});

		if (prompt) {
			return {
				systemPrompt: (event.systemPrompt ?? "") + prompt,
			};
		}
		return {};
	});

	// 5. Format-on-write: sync files with LSP after edit/write operations
	pi.on("tool_result", (event) => {
		if (event.isError) return;

		let filePath: string | undefined;
		if (isEditToolResult(event)) {
			filePath = (event.input as { path?: string }).path;
		} else if (isWriteToolResult(event)) {
			filePath = (event.input as { path?: string }).path;
		}

		if (filePath) {
			// Sync the modified file with all active LSP servers
			// This triggers diagnostics updates without blocking the tool result
			lspManager.getClientForFile(filePath).then((client) => {
				if (client) {
					lspManager.syncFile(client, filePath!).catch(() => {
						// Silently ignore sync errors
					});
				}
			}).catch(() => {
				// No server available — ignore
			});
		}
	});

	// 6. Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		await Promise.allSettled([lspManager.shutdown(), semvex.shutdown()]);
	});
};

export default piCodeIntel;
