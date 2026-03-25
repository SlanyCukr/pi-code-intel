import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { groupTemplatesByCategory } from "../agents/templates.js";
import { getString, parseFrontmatter } from "../utils/frontmatter.js";
import { loadMarkdownDir } from "../utils/templates.js";

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
	const parsed = parseFrontmatter(content);
	if (!parsed) return null;

	const { frontmatter, body } = parsed;
	const prompt = body.trim();

	const name = getString(frontmatter, "name");
	const description = getString(frontmatter, "description");
	if (!name || !description) return null;

	return {
		name,
		description,
		argumentHint: getString(frontmatter, "argument-hint"),
		prompt,
	};
}

/**
 * Load all command templates from the templates directory.
 */
function loadCommandTemplates(): CommandTemplate[] {
	return loadMarkdownDir<CommandTemplate>(
		join(__dirname, "templates"),
		(content, file) => {
			const template = parseCommandTemplate(content);
			if (!template) {
				console.error(
					`[code-intel] Failed to parse command template: ${file} (check frontmatter format)`,
				);
			}
			return template;
		},
	);
}

/**
 * Register all command templates as pi slash commands.
 *
 * Each command expands its template (replacing $ARGUMENTS) and injects the result
 * into the conversation via sendUserMessage (or sendMessage with display:false
 * as a fallback for older SDK versions).
 */
export function registerCommands(pi: ExtensionAPI): void {
	// Cast to any: pi.registerCommand and pi.sendUserMessage exist
	// on the runtime API but may not be in the type declarations
	// bundled with older versions of the SDK.
	const piAny = pi as any;

	if (typeof piAny.registerCommand !== "function") {
		console.error(
			"[code-intel] SDK does not support registerCommand — slash commands unavailable",
		);
		return;
	}

	// Register command templates from the templates directory
	const templates = loadCommandTemplates();
	for (const template of templates) {
		piAny.registerCommand(template.name, {
			description: template.description,
			handler: async (args: string) => {
				const expanded = template.prompt.replace(/\$ARGUMENTS/g, args || "");
				if (typeof piAny.sendUserMessage === "function") {
					piAny.sendUserMessage(expanded);
				} else if (typeof piAny.sendMessage === "function") {
					piAny.sendMessage(
						{ content: expanded, display: false },
						{ triggerTurn: true },
					);
				} else {
					console.error(
						"[code-intel] Cannot send command message: SDK does not expose sendUserMessage or sendMessage",
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
			const byCategory = groupTemplatesByCategory();
			if (byCategory.size === 0) {
				ctx.ui.notify("No sub-agents available", "info");
				return;
			}

			const lines: string[] = [];
			for (const [category, agents] of byCategory) {
				lines.push(`\n${category}:`);
				for (const agent of agents) {
					const model =
						agent.model === "inherit" ? "inherits parent" : agent.model;
					lines.push(
						`  ${category}:${agent.name}  (${model})  ${agent.description}`,
					);
					lines.push(`    tools: [${agent.tools.join(", ")}]`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
