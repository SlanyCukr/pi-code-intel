import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getArray, getString, parseFrontmatter } from "../utils/frontmatter.js";
import { loadMarkdownDir } from "../utils/templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AgentTemplate {
	name: string;
	category: string;
	description: string;
	model: "sonnet" | "opus" | "inherit";
	thinkingLevel: ThinkingLevel;
	tools: string[];
	systemPrompt: string;
}

const VALID_MODELS = ["sonnet", "opus", "inherit"] as const;
const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

// Template cache
let templateCache: Map<string, AgentTemplate> | null = null;

/**
 * Parse a template markdown file with YAML-like frontmatter.
 */
function parseTemplate(content: string): AgentTemplate | null {
	const parsed = parseFrontmatter(content);
	if (!parsed) return null;

	const { frontmatter, body } = parsed;
	const systemPrompt = body.trim();

	const name = getString(frontmatter, "name");
	const category = getString(frontmatter, "category");
	const description = getString(frontmatter, "description");
	const rawModel = getString(frontmatter, "model");
	const rawThinking = getString(frontmatter, "thinkingLevel") ?? "medium";

	if (!name || !category || !description || !rawModel) return null;
	if (!VALID_MODELS.includes(rawModel as (typeof VALID_MODELS)[number]))
		return null;
	if (!VALID_THINKING_LEVELS.includes(rawThinking as ThinkingLevel))
		return null;

	return {
		name,
		category,
		description,
		model: rawModel as AgentTemplate["model"],
		thinkingLevel: rawThinking as ThinkingLevel,
		tools: getArray(frontmatter, "tools"),
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

	let categories: string[];
	try {
		categories = readdirSync(templatesDir);
	} catch (err) {
		console.error(
			"[code-intel] Failed to load agent templates:",
			err instanceof Error ? err.message : err,
		);
		templateCache = new Map();
		return templateCache;
	}

	for (const category of categories) {
		const categoryDir = join(templatesDir, category);
		try {
			if (!statSync(categoryDir).isDirectory()) continue;
		} catch {
			continue;
		}

		const parsed = loadMarkdownDir<AgentTemplate>(categoryDir, (content, file) => {
			const template = parseTemplate(content);
			if (!template) {
				console.error(
					`[code-intel] Skipped agent template ${file}: failed to parse frontmatter (check name, category, model, thinkingLevel fields)`,
				);
			}
			return template;
		});

		for (const template of parsed) {
			templates.set(`${template.category}:${template.name}`, template);
		}
	}

	templateCache = templates;
	return templateCache;
}

/**
 * Reset the template cache so the next loadTemplates() call re-reads from disk.
 * Intended for test isolation.
 */
export function resetTemplateCache(): void {
	templateCache = null;
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
 * Group templates by category.
 */
export function groupTemplatesByCategory(): Map<string, AgentTemplate[]> {
	const byCategory = new Map<string, AgentTemplate[]>();
	for (const template of listTemplates()) {
		const list = byCategory.get(template.category) ?? [];
		list.push(template);
		byCategory.set(template.category, list);
	}
	return byCategory;
}

/**
 * Determine if a template needs write tools (edit/write).
 */
export function templateNeedsWriteTools(template: AgentTemplate): boolean {
	return (
		template.tools.includes("edit") ||
		template.tools.includes("write")
	);
}
