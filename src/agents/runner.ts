import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CreateAgentSessionOptions,
	SessionManager,
	createAgentSession,
	createCodingTools,
	createReadOnlyTools,
} from "@mariozechner/pi-coding-agent";
import { buildCodeExplorationGuidance } from "../prompt/code-exploration.js";
// Model<any> is the canonical type used throughout pi-coding-agent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = import("@mariozechner/pi-ai").Model<any>;

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AgentTemplate {
	name: string;
	category: string;
	description: string;
	model: "sonnet" | "opus" | "inherit";
	tools: string[];
	systemPrompt: string;
}

export interface SubAgentResult {
	output: string;
	error?: string;
}

const VALID_MODELS = ["sonnet", "opus", "inherit"] as const;

const FORWARD_INTELLIGENCE = `<instruction>
## Forward intelligence

When relevant, note in your output:
- Insights that would prevent rework for whoever acts on your findings
- Fragile spots — thin implementations or assumptions that may break under change
- Surprises — where reality differed from what you expected
</instruction>`;

// Template cache
let templateCache: Map<string, AgentTemplate> | null = null;

/**
 * Parse a template markdown file with YAML-like frontmatter.
 */
function parseTemplate(content: string): AgentTemplate | null {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return null;

	const frontmatter = fmMatch[1];
	const systemPrompt = fmMatch[2].trim();

	const getString = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match ? match[1].trim() : undefined;
	};

	const getArray = (key: string): string[] => {
		const match = frontmatter.match(
			new RegExp(`^${key}:\\s*\\[([^\\]]+)\\]`, "m"),
		);
		if (!match) return [];
		return match[1].split(",").map((s) => s.trim());
	};

	const name = getString("name");
	const category = getString("category");
	const description = getString("description");
	const rawModel = getString("model");

	if (!name || !category || !description || !rawModel) return null;
	if (!VALID_MODELS.includes(rawModel as (typeof VALID_MODELS)[number]))
		return null;

	return {
		name,
		category,
		description,
		model: rawModel as AgentTemplate["model"],
		tools: getArray("tools"),
		systemPrompt,
	};
}

/**
 * Load all templates from the templates directory.
 */
export function loadTemplates(): Map<string, AgentTemplate> {
	if (templateCache) return templateCache;

	templateCache = new Map();
	const templatesDir = join(__dirname, "templates");

	try {
		const categories = readdirSync(templatesDir);
		for (const category of categories) {
			const categoryDir = join(templatesDir, category);
			if (!statSync(categoryDir).isDirectory()) continue;

			const files = readdirSync(categoryDir);
			for (const file of files) {
				if (!file.endsWith(".md")) continue;

				const filePath = join(categoryDir, file);
				const content = readFileSync(filePath, "utf-8");
				const template = parseTemplate(content);
				if (template) {
					const fullName = `${template.category}:${template.name}`;
					templateCache.set(fullName, template);
				}
			}
		}
	} catch {
		// Templates directory not found — continue with empty cache
	}

	return templateCache;
}

/**
 * Get a template by its full name (category:name).
 */
export function getTemplate(fullName: string): AgentTemplate | null {
	const templates = loadTemplates();
	return templates.get(fullName) ?? null;
}

/**
 * List all available templates.
 */
export function listTemplates(): AgentTemplate[] {
	const templates = loadTemplates();
	return Array.from(templates.values());
}

/**
 * Determine if a template needs write tools.
 */
function templateNeedsWriteTools(template: AgentTemplate): boolean {
	return (
		template.tools.includes("edit") ||
		template.tools.includes("write") ||
		template.tools.includes("bash")
	);
}

/**
 * Extract text content from agent messages.
 */
function extractTextFromMessages(
	messages: Array<{ role: string; content: unknown }>,
): string {
	const assistantMessages = messages.filter((m) => m.role === "assistant");
	const parts: string[] = [];

	for (const msg of assistantMessages) {
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
	}

	return parts.join("\n\n");
}

/**
 * Run a sub-agent using the pi SDK's createAgentSession.
 *
 * Creates an in-memory AgentSession, runs the task to completion,
 * extracts the output, and disposes the session.
 */
export async function runSubAgent(
	template: AgentTemplate,
	task: string,
	cwd: string,
	parentModel: AnyModel | undefined,
	customTools: CreateAgentSessionOptions["customTools"],
	signal?: AbortSignal,
): Promise<SubAgentResult> {
	// Resolve model: "inherit" uses parent model, otherwise undefined (let SDK resolve)
	const model: AnyModel | undefined =
		template.model === "inherit" ? parentModel : undefined;

	try {
		// Select built-in tools based on template needs
		const builtInTools = templateNeedsWriteTools(template)
			? createCodingTools(cwd)
			: createReadOnlyTools(cwd);

		// Filter custom tools to only those listed in the template
		const filteredCustomTools = customTools?.filter((t) =>
			template.tools.includes(t.name),
		);

		const { session } = await createAgentSession({
			cwd,
			model,
			tools: builtInTools,
			customTools: filteredCustomTools,
			sessionManager: SessionManager.inMemory(cwd),
		});

		// Build system prompt: template prompt + shared guidance
		const hasLsp = filteredCustomTools?.some((t) => t.name === "lsp") ?? false;
		const hasSearch =
			filteredCustomTools?.some((t) => t.name === "search_code") ?? false;
		const codeExploration = buildCodeExplorationGuidance(hasLsp, hasSearch);
		const extras: string[] = [];
		if (codeExploration) extras.push(codeExploration);
		extras.push(FORWARD_INTELLIGENCE);
		const systemPrompt = `${template.systemPrompt}\n\n${extras.join("\n\n")}`;
		session.agent.setSystemPrompt(systemPrompt);

		// Abort if signal fires
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					session.abort();
				},
				{ once: true },
			);
		}

		// Run the task
		await session.prompt(task);

		// Extract output from all assistant messages
		const output = extractTextFromMessages(
			session.messages as Array<{ role: string; content: unknown }>,
		);

		// Clean up
		session.dispose();

		return {
			output: output || "Sub-agent completed with no text output.",
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { output: "", error: `Sub-agent error: ${message}` };
	}
}
