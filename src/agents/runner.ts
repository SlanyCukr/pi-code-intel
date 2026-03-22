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

// Depth counter: prevents the extension from registering the agent tool
// inside sub-agent sessions (createAgentSession loads extensions by default).
let subAgentDepth = 0;
export function isInSubAgent(): boolean {
	return subAgentDepth > 0;
}

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

	const templates = new Map<string, AgentTemplate>();
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
					templates.set(fullName, template);
				}
			}
		}
	} catch (err) {
		console.error(
			"[code-intel] Failed to load agent templates:",
			err instanceof Error ? err.message : err,
		);
		return new Map();
	}

	templateCache = templates;
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
 * Run a sub-agent using the pi SDK's createAgentSession.
 *
 * Creates an in-memory AgentSession, runs the task to completion,
 * extracts the output, and disposes the session.
 *
 * @param onProgress Optional callback invoked with status strings as the sub-agent executes tools.
 */
export type ProgressCallback = (status: string) => void;

export async function runSubAgent(
	template: AgentTemplate,
	task: string,
	cwd: string,
	parentModel: AnyModel | undefined,
	customTools: CreateAgentSessionOptions["customTools"],
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
): Promise<SubAgentResult> {
	// Resolve model: "inherit" uses parent model, otherwise undefined (let SDK resolve)
	const model: AnyModel | undefined =
		template.model === "inherit" ? parentModel : undefined;

	// Declare outside try so cleanup is accessible from catch/finally
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
	let unsub: (() => void) | null = null;
	let abortHandler: (() => void) | null = null;

	subAgentDepth++;
	try {
		// Select built-in tools based on template needs
		const builtInTools = templateNeedsWriteTools(template)
			? createCodingTools(cwd)
			: createReadOnlyTools(cwd);

		// Filter custom tools to only those listed in the template
		const filteredCustomTools = customTools?.filter((t) =>
			template.tools.includes(t.name),
		);

		({ session } = await createAgentSession({
			cwd,
			model,
			tools: builtInTools,
			customTools: filteredCustomTools,
			sessionManager: SessionManager.inMemory(cwd),
		}));

		// Build system prompt: template prompt + code exploration guidance (if LSP/search available) + forward intelligence
		const hasLsp = filteredCustomTools?.some((t) => t.name === "lsp") ?? false;
		const hasSearch =
			filteredCustomTools?.some((t) => t.name === "search_code") ?? false;
		const codeExploration = buildCodeExplorationGuidance(hasLsp, hasSearch);
		const extras: string[] = [];
		if (codeExploration) extras.push(codeExploration);
		extras.push(FORWARD_INTELLIGENCE);
		const systemPrompt = `${template.systemPrompt}\n\n${extras.join("\n\n")}`;
		session.agent.setSystemPrompt(systemPrompt);

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
