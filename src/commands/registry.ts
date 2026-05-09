import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { groupTemplatesByCategory } from "../agents/templates.js";
import { getString, parseFrontmatter } from "../utils/frontmatter.js";
import { loadMarkdownDir } from "../utils/templates.js";

/**
 * Subset of the runtime ExtensionAPI we depend on.
 *
 * The pi SDK ships these methods but their type declarations vary across
 * minor versions; the explicit shape below isolates that volatility into one
 * place and avoids `pi as any` escape hatches everywhere we touch them.
 * `registerCommand` and `sendUserMessage` are guaranteed by peerDep
 * `>=0.62.0`. Older callers of `sendMessage` are no longer supported.
 */
interface CommandRegistryApi {
	registerCommand?(
		name: string,
		def: {
			description: string;
			handler: (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => unknown;
		},
	): void;
	sendUserMessage?(text: string): void;
}

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
 * Each command expands its template (replacing $ARGUMENTS and
 * $EXTENSION_DIST) and injects the result into the conversation via
 * `sendUserMessage`.
 *
 * `$EXTENSION_DIST` is substituted with the absolute path to this
 * extension's compiled `dist/` directory. Use it in templates that
 * need to invoke a script shipped with the extension — the user's
 * working directory is unrelated to where the extension lives, so a
 * relative `dist/...` path would resolve into the user's project and
 * fail.
 */
export function registerCommands(pi: ExtensionAPI): void {
	const api = pi as ExtensionAPI & CommandRegistryApi;

	if (typeof api.registerCommand !== "function") {
		console.error(
			"[code-intel] SDK does not support registerCommand — slash commands unavailable",
		);
		return;
	}
	if (typeof api.sendUserMessage !== "function") {
		console.error(
			"[code-intel] SDK does not expose sendUserMessage — slash commands unavailable",
		);
		return;
	}

	// Compute the extension's dist root once at registration time.
	// Templates are loaded from `<dist>/commands/templates/`; `__dirname`
	// here is `<dist>/commands/`, so its parent is `<dist>`.
	const extensionDist = dirname(__dirname);
	const sendUserMessage = api.sendUserMessage.bind(api);

	// Register command templates from the templates directory
	const templates = loadCommandTemplates();
	for (const template of templates) {
		api.registerCommand(template.name, {
			description: template.description,
			handler: async (args: string) => {
				const expanded = template.prompt
					.replace(/\$ARGUMENTS/g, args || "")
					.replace(/\$EXTENSION_DIST/g, extensionDist);
				sendUserMessage(expanded);
			},
		});
	}

	// Register /agents command to list available sub-agents
	api.registerCommand("agents", {
		description: "List available sub-agents",
		handler: async (_args, ctx) => {
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
