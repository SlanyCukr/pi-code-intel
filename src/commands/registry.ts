import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listTemplates } from "../agents/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CommandTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	prompt: string;
}

/**
 * Parse a command template markdown file with YAML-like frontmatter.
 */
function parseCommandTemplate(content: string): CommandTemplate | null {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return null;

	const frontmatter = fmMatch[1];
	const prompt = fmMatch[2].trim();

	const getString = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match ? match[1].trim().replace(/^["']|["']$/g, "") : undefined;
	};

	const name = getString("name");
	const description = getString("description");
	if (!name || !description) return null;

	return {
		name,
		description,
		argumentHint: getString("argument-hint"),
		prompt,
	};
}

/**
 * Load all command templates from the templates directory.
 */
function loadCommandTemplates(): CommandTemplate[] {
	const templatesDir = join(__dirname, "templates");
	const templates: CommandTemplate[] = [];

	try {
		const files = readdirSync(templatesDir);
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const content = readFileSync(join(templatesDir, file), "utf-8");
			const template = parseCommandTemplate(content);
			if (template) {
				templates.push(template);
			}
		}
	} catch {
		// Templates directory not found — continue without commands
	}

	return templates;
}

/**
 * Register all command templates as pi slash commands.
 *
 * Each command expands its template (replacing $ARGUMENTS) and sends
 * it as a user message to trigger the agent.
 */
export function registerCommands(pi: ExtensionAPI): void {
	// Cast to any: pi.registerCommand and pi.sendUserMessage exist
	// on the runtime API but may not be in the type declarations
	// bundled with older versions of the SDK.
	const piAny = pi as any;

	if (typeof piAny.registerCommand !== "function") {
		// SDK version doesn't support registerCommand — skip silently
		return;
	}

	// Register command templates (feature-dev, review-pr)
	const templates = loadCommandTemplates();
	for (const template of templates) {
		piAny.registerCommand(template.name, {
			description: template.description,
			handler: async (args: string) => {
				const expanded = template.prompt.replace(
					/\$ARGUMENTS/g,
					args || "",
				);
				if (typeof piAny.sendUserMessage === "function") {
					piAny.sendUserMessage(expanded);
				} else if (typeof piAny.sendMessage === "function") {
					piAny.sendMessage(
						{ content: expanded, display: false },
						{ triggerTurn: true },
					);
				}
			},
		});
	}

	// Register /agents command to list available sub-agents
	registerAgentsCommand(piAny);
}

function registerAgentsCommand(pi: any): void {
	pi.registerCommand("agents", {
		description: "List available sub-agents",
		handler: async (_args: string, ctx: any) => {
			const agents = listTemplates();
			if (agents.length === 0) {
				ctx.ui.notify("No sub-agents available", "info");
				return;
			}

			const lines: string[] = [];
			const byCategory = new Map<string, typeof agents>();
			for (const agent of agents) {
				const list = byCategory.get(agent.category) ?? [];
				list.push(agent);
				byCategory.set(agent.category, list);
			}

			for (const [category, categoryAgents] of byCategory) {
				lines.push(`\n${category}:`);
				for (const agent of categoryAgents) {
					const model =
						agent.model === "inherit"
							? "inherits parent"
							: agent.model;
					lines.push(
						`  ${category}:${agent.name}  (${model})  ${agent.description}`,
					);
					lines.push(
						`    tools: [${agent.tools.join(", ")}]`,
					);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
