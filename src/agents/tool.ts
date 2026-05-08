import { Type, type Static } from "@sinclair/typebox";
import type {
	ExtensionContext,
	ToolDefinition,
	AgentToolUpdateCallback,
	CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { runSubAgent } from "./runner.js";
import {
	getTemplate,
	groupTemplatesByCategory,
	listTemplates,
} from "./templates.js";

// Hard bounds on the LLM-requested timeout. The default (set in runner.ts)
// applies when this is omitted. Bounds prevent a hallucinated value from
// either aborting almost immediately or running effectively forever.
const MIN_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const agentSchema = Type.Object(
	{
		type: Type.String({
			description:
				"The sub-agent type to run. Use the format 'category:name'. Available types are listed in the tool description.",
		}),
		task: Type.String({
			description:
				"The task to delegate to the sub-agent. Be specific and include all relevant context.",
		}),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: MIN_TIMEOUT_MS,
				maximum: MAX_TIMEOUT_MS,
				description:
					"Optional sub-agent timeout in milliseconds. Defaults to 15 minutes when omitted. Use a larger value (up to 30 minutes) for review-heavy or wide-exploration tasks; smaller for quick lookups. Minimum 30000 (30s).",
			}),
		),
	},
	{ additionalProperties: false },
);

type AgentInput = Static<typeof agentSchema>;

function buildDescription(): string {
	let desc =
		"Delegate a task to a specialized sub-agent. The sub-agent runs to completion and returns its output.\n\n";
	desc += "Available agent types:\n";

	for (const [category, agents] of groupTemplatesByCategory()) {
		desc += `\n${category}:\n`;
		for (const agent of agents) {
			const model =
				agent.model === "inherit"
					? "inherits parent model"
					: agent.model;
			desc += `  - ${category}:${agent.name} (${model}): ${agent.description}\n`;
		}
	}

	return desc;
}

export function createAgentTool(
	customTools: CreateAgentSessionOptions["customTools"],
): ToolDefinition<typeof agentSchema> {
	return {
		name: "agent",
		label: "Agent",
		description: buildDescription(),
		parameters: agentSchema,
		async execute(
			_toolCallId: string,
			input: AgentInput,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const template = getTemplate(input.type);
			if (!template) {
				const available = listTemplates()
					.map((t) => `${t.category}:${t.name}`)
					.join(", ");
				throw new Error(
					`Unknown agent type: ${input.type}. Available types: ${available}`,
				);
			}

			// Emit initial progress so the TUI shows what's running
			const taskPreview = input.task.length > 120
				? `${input.task.slice(0, 120)}…`
				: input.task;
			onUpdate?.({
				content: [{ type: "text" as const, text: `[${input.type}] ${taskPreview}` }],
				details: undefined,
			});

			// Stream tool execution progress
			const onProgress = onUpdate
				? (status: string) => {
						onUpdate({
							content: [{ type: "text" as const, text: `[${input.type}] ${status}` }],
							details: undefined,
						});
					}
				: undefined;

			// Resolve subagent session dir from parent context for disk persistence
			const sessionDir = ctx.sessionManager.getSessionDir();

			const result = await runSubAgent({
				template,
				task: input.task,
				cwd: ctx.cwd,
				parentModel: ctx.model,
				customTools,
				signal,
				onProgress,
				parentSessionDir: sessionDir,
				timeout: input.timeoutMs,
			});

			if (result.error) {
				throw new Error(
					`${result.error}\n\nPartial output:\n${result.output}`,
				);
			}

			return {
				content: [{ type: "text" as const, text: result.output }],
				details: undefined,
			};
		},
	};
}
