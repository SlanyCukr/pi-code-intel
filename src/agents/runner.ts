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
import { LSP_TOOL_NAME } from "../lsp/tool.js";
import { rtkSpawnHook } from "../rtk.js";

const BASH_GUIDANCE = `<instruction>
## Bash usage

- Bash commands already execute in the project root directory. Prefixing with \`cd /path/to/project &&\` is redundant — it wastes tokens and clutters the command.
- Bash output is automatically compressed for token efficiency. grep and find via bash automatically respect .gitignore — you do not need \`--exclude-dir\` or manual filtering.
- Use bash for: grep, find, ls, git commands, npm/build commands, ast-grep, and other shell operations.
- When you need to understand code structure or find where something is defined/used, prefer lsp — it returns precise, structural results in a single call.
</instruction>`;

const FORWARD_INTELLIGENCE = `<instruction>
## Forward intelligence

When relevant, note in your output:
- Insights that would prevent rework for whoever acts on your findings
- Fragile spots — thin implementations or assumptions that may break under change
- Surprises — where reality differed from what you expected
</instruction>`;
import type { AgentTemplate } from "./templates.js";
import { templateNeedsWriteTools } from "./templates.js";
import type { AnyModel } from "../types.js";

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
function createBuiltInTools(template: AgentTemplate, cwd: string) {
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
	const hasLsp = filteredCustomTools?.some((t) => t.name === LSP_TOOL_NAME) ?? false;
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

// 15 minutes. Empirically, review-heavy sub-agents (intent-reviewer,
// code-reviewer) routinely need 6–10 minutes for non-trivial tasks; the prior
// 5-minute cap killed productive runs mid-flight. Callers can override per
// invocation via the `timeout` option, or disable entirely with `timeout: 0`.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

interface RunSubAgentOptions {
	template: AgentTemplate;
	task: string;
	cwd: string;
	parentModel: AnyModel | undefined;
	customTools: CreateAgentSessionOptions["customTools"];
	signal?: AbortSignal;
	onProgress?: (status: string) => void;
	parentSessionDir?: string;
	/** Timeout in milliseconds. Defaults to 5 minutes. Set to 0 to disable. */
	timeout?: number;
}

/**
 * Run a sub-agent using the pi SDK's createAgentSession.
 *
 * Creates an AgentSession (disk-persisted when parentSessionDir is provided,
 * otherwise in-memory), runs the task to completion, extracts the output,
 * and disposes the session.
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
	const { template, task, cwd, parentModel, customTools, signal, onProgress, parentSessionDir, timeout } = options;
	// Resolve model: "inherit" uses parent model, otherwise undefined (let SDK resolve)
	const model: AnyModel | undefined =
		template.model === "inherit" ? parentModel : undefined;

	// Declare outside try so cleanup is accessible from catch/finally
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
	let unsub: (() => void) | null = null;
	let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

	subAgentDepth++;
	try {
		const builtInTools = createBuiltInTools(template, cwd);
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

		// Stream progress via session events — tool usage + partial assistant text
		let toolCount = 0;
		let currentTool = "";
		unsub = session.subscribe((event: { type: string; toolName?: string; toolCallId?: string; text?: string }) => {
			if (!onProgress) return;
			if (event.type === "tool_execution_start") {
				toolCount++;
				currentTool = event.toolName ?? "";
				onProgress(`tool ${toolCount}: ${currentTool}`);
			} else if (event.type === "tool_execution_end") {
				onProgress(`tool ${toolCount}: ${currentTool} done`);
			} else if (event.type === "message_update" && event.text) {
				// Show first ~120 chars of the latest assistant text as a progress hint
				const preview = event.text.length > 120
					? `${event.text.slice(0, 120)}…`
					: event.text;
				onProgress(`finding: ${preview}`);
			}
		});

		// Abort if signal fires. `{ once: true }` auto-removes the listener after
		// firing; nothing to clean up in `finally`.
		if (signal) {
			signal.addEventListener("abort", () => session?.abort(), { once: true });
		}

		// Timeout — abort the session if it runs too long
		let timedOut = false;
		const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				console.error(`[code-intel] Sub-agent ${template.name} timed out after ${timeoutMs}ms`);
				session?.abort();
			}, timeoutMs);
		}

		// Run the task
		await session.prompt(task);

		// Extract the final report from the last assistant message
		const output = extractFinalReport(
			session.messages as Array<{ role: string; content: unknown }>,
		);

		if (timedOut) {
			return {
				output: output || "",
				error: `Sub-agent ${template.name} timed out after ${timeoutMs}ms. Output may be incomplete.`,
			};
		}

		return {
			output: output || "Sub-agent completed with no text output.",
		};
	} catch (err) {
		console.error(`[code-intel] Sub-agent ${template.name} failed:`, err);
		const message = err instanceof Error ? err.message : String(err);
		return { output: "", error: `Sub-agent error: ${message}` };
	} finally {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		unsub?.();
		session?.dispose();
		subAgentDepth--;
	}
}
