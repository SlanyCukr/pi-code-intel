import { Type, type Static } from "@sinclair/typebox";
import type {
	ExtensionContext,
	ToolDefinition,
	AgentToolUpdateCallback,
	CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	type AgentTemplate,
	getTemplate,
	listTemplates,
	runSubAgent,
} from "./runner.js";

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
	},
	{ additionalProperties: false },
);

type AgentInput = Static<typeof agentSchema>;

function buildDescription(): string {
	const templates = listTemplates();

	const byCategory = new Map<string, AgentTemplate[]>();
	for (const t of templates) {
		const existing = byCategory.get(t.category) ?? [];
		existing.push(t);
		byCategory.set(t.category, existing);
	}

	let desc =
		"Delegate a task to a specialized sub-agent. The sub-agent runs to completion and returns its output.\n\n";
	desc += "Available agent types:\n";

	for (const [category, agents] of byCategory) {
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

			const result = await runSubAgent(
				template,
				input.task,
				ctx.cwd,
				ctx.model,
				customTools,
				signal,
				onProgress,
			);

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
