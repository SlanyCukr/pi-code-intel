import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type CreateAgentSessionOptions,
	SessionManager,
	createAgentSession,
	createBashTool,
	createCodingTools,
	createReadOnlyTools,
} from "@mariozechner/pi-coding-agent";
import { buildCodeExplorationGuidance } from "../prompt/code-exploration.js";
import { BASH_GUIDANCE, FORWARD_INTELLIGENCE } from "../prompt/subagent-prompt.js";
import { rtkSpawnHook } from "../rtk.js";
import type { AgentTemplate } from "./templates.js";
import { templateNeedsWriteTools } from "./templates.js";
// Model<any> is the canonical type used throughout pi-coding-agent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = import("@mariozechner/pi-ai").Model<any>;

// Depth counter: prevents the extension from registering the agent tool
// inside sub-agent sessions (createAgentSession loads extensions by default).
let subAgentDepth = 0;
export function isInSubAgent(): boolean {
	return subAgentDepth > 0;
}

interface SubAgentResult {
	output: string;
	error?: string;
}

/**
 * Extract the final report from agent messages.
 *
 * Takes only the last assistant message's text blocks — earlier messages
 * are stream-of-consciousness narration, not the final report.
 */
export function extractFinalReport(
	messages: Array<{ role: string; content: unknown }>,
): string {
	// Walk backwards to find the last assistant message with text
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;

		const parts: string[] = [];
		if (typeof msg.content === "string") {
			parts.push(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content as Array<{
				type: string;
				text?: string;
			}>) {
				if (block.type === "text" && block.text) {
					parts.push(block.text);
				}
			}
		}

		const text = parts.join("\n\n").trim();
		if (text) return text;
	}

	return "";
}

/**
 * Select built-in tools based on template needs.
 *
 * Write agents get the full coding toolset. Read-only agents get read tools
 * plus bash (if declared). RTK spawn hook wraps all bash invocations.
 */
function selectBuiltInTools(template: AgentTemplate, cwd: string) {
	const rtkBashOpts = { bash: { spawnHook: rtkSpawnHook } };
	if (templateNeedsWriteTools(template)) {
		return createCodingTools(cwd, rtkBashOpts);
	}
	if (template.tools.includes("bash")) {
		return [...createReadOnlyTools(cwd), createBashTool(cwd, { spawnHook: rtkSpawnHook })];
	}
	return createReadOnlyTools(cwd);
}

/**
 * Build the composite system prompt for a sub-agent.
 *
 * Appends bash guidance, code exploration guidance, and forward intelligence
 * sections to the template's base prompt.
 */
function buildSubAgentSystemPrompt(
	template: AgentTemplate,
	filteredCustomTools: CreateAgentSessionOptions["customTools"],
): string {
	const hasLsp = filteredCustomTools?.some((t) => t.name === "lsp") ?? false;
	const codeExploration = buildCodeExplorationGuidance(hasLsp);
	const extras: string[] = [];
	if (template.tools.includes("bash")) extras.push(BASH_GUIDANCE);
	if (codeExploration) extras.push(codeExploration);
	extras.push(FORWARD_INTELLIGENCE);
	return `${template.systemPrompt}\n\n${extras.join("\n\n")}`;
}

/**
 * Create a SessionManager, persisting to disk when possible.
 */
function createSessionStorage(cwd: string, parentSessionDir?: string): SessionManager {
	if (parentSessionDir) {
		const subagentsDir = join(parentSessionDir, "subagents");
		try {
			mkdirSync(subagentsDir, { recursive: true });
			return SessionManager.create(cwd, subagentsDir);
		} catch (err) {
			console.error(
				`[code-intel] Cannot persist subagent session to ${subagentsDir}, falling back to in-memory:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	return SessionManager.inMemory(cwd);
}

type ProgressCallback = (status: string) => void;

interface RunSubAgentOptions {
	template: AgentTemplate;
	task: string;
	cwd: string;
	parentModel: AnyModel | undefined;
	customTools: CreateAgentSessionOptions["customTools"];
	signal?: AbortSignal;
	onProgress?: ProgressCallback;
	parentSessionDir?: string;
}

/**
 * Run a sub-agent using the pi SDK's createAgentSession.
 *
 * Creates an AgentSession (disk-persisted when parentSessionDir is provided,
 * otherwise in-memory), runs the task to completion, extracts the output,
 * and disposes the session.
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
	const { template, task, cwd, parentModel, customTools, signal, onProgress, parentSessionDir } = options;
	// Resolve model: "inherit" uses parent model, otherwise undefined (let SDK resolve)
	const model: AnyModel | undefined =
		template.model === "inherit" ? parentModel : undefined;

	// Declare outside try so cleanup is accessible from catch/finally
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
	let unsub: (() => void) | null = null;
	let abortHandler: (() => void) | null = null;

	subAgentDepth++;
	try {
		const builtInTools = selectBuiltInTools(template, cwd);
		const filteredCustomTools = customTools?.filter((t) =>
			template.tools.includes(t.name),
		);

		({ session } = await createAgentSession({
			cwd,
			model,
			thinkingLevel: template.thinkingLevel,
			tools: builtInTools,
			customTools: filteredCustomTools,
			sessionManager: createSessionStorage(cwd, parentSessionDir),
		}));

		// Enforce template tool list — hide tools the template doesn't declare
		session.setActiveToolsByName(template.tools);
		session.agent.setSystemPrompt(buildSubAgentSystemPrompt(template, filteredCustomTools));

		// Stream progress via session events
		let toolCount = 0;
		let currentTool = "";
		unsub = session.subscribe((event: { type: string; toolName?: string; toolCallId?: string }) => {
			if (!onProgress) return;
			if (event.type === "tool_execution_start") {
				toolCount++;
				currentTool = event.toolName ?? "";
				onProgress(`tool ${toolCount}: ${currentTool}`);
			} else if (event.type === "tool_execution_end") {
				onProgress(`tool ${toolCount}: ${currentTool} done`);
			}
		});

		// Abort if signal fires
		if (signal) {
			abortHandler = () => session?.abort();
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		// Run the task
		await session.prompt(task);

		// Extract the final report from the last assistant message
		const output = extractFinalReport(
			session.messages as Array<{ role: string; content: unknown }>,
		);

		return {
			output: output || "Sub-agent completed with no text output.",
		};
	} catch (err) {
		console.error(`[code-intel] Sub-agent ${template.name} failed:`, err);
		const message = err instanceof Error ? err.message : String(err);
		return { output: "", error: `Sub-agent error: ${message}` };
	} finally {
		unsub?.();
		if (signal && abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
		session?.dispose();
		subAgentDepth--;
	}
}
