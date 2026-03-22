import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, "../../src/commands/templates");

/**
 * Minimal parser matching the registry's parseCommandTemplate logic.
 */
function parseCommandTemplate(content: string) {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return null;

	const frontmatter = fmMatch[1];
	const prompt = fmMatch[2].trim();

	const getString = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match ? match[1].trim().replace(/^["']|["']$/g, "") : undefined;
	};

	return {
		name: getString("name"),
		description: getString("description"),
		argumentHint: getString("argument-hint"),
		prompt,
	};
}

describe("command templates", () => {
	it("templates directory contains expected files", () => {
		const files = readdirSync(templatesDir).filter((f) =>
			f.endsWith(".md"),
		);
		expect(files).toContain("feature-dev.md");
		expect(files).toContain("review-pr.md");
	});

	it("all templates parse successfully", () => {
		const files = readdirSync(templatesDir).filter((f) =>
			f.endsWith(".md"),
		);
		for (const file of files) {
			const content = readFileSync(join(templatesDir, file), "utf-8");
			const template = parseCommandTemplate(content);
			expect(template, `Failed to parse ${file}`).not.toBeNull();
			expect(template!.name, `${file} missing name`).toBeTruthy();
			expect(
				template!.description,
				`${file} missing description`,
			).toBeTruthy();
			expect(
				template!.prompt.length,
				`${file} has empty prompt`,
			).toBeGreaterThan(100);
		}
	});
});

describe("feature-dev template", () => {
	const content = readFileSync(
		join(templatesDir, "feature-dev.md"),
		"utf-8",
	);
	const template = parseCommandTemplate(content)!;

	it("has correct metadata", () => {
		expect(template.name).toBe("feature-dev");
		expect(template.description).toContain("feature development");
	});

	it("contains $ARGUMENTS placeholder", () => {
		expect(template.prompt).toContain("$ARGUMENTS");
	});

	it("references all 7 phases", () => {
		for (let i = 1; i <= 7; i++) {
			expect(template.prompt).toContain(`Phase ${i}`);
		}
	});

	it("references sub-agents", () => {
		expect(template.prompt).toContain("code-explorer");
		expect(template.prompt).toContain("code-architect");
		expect(template.prompt).toContain("code-reviewer");
	});

	it("has user checkpoints", () => {
		expect(template.prompt).toContain(
			"Wait for answers before proceeding",
		);
		expect(template.prompt).toContain(
			"DO NOT START WITHOUT USER APPROVAL",
		);
		expect(template.prompt).toContain(
			"Ask user which approach they prefer",
		);
	});

	it("$ARGUMENTS replacement works", () => {
		const expanded = template.prompt.replace(
			/\$ARGUMENTS/g,
			"Add caching",
		);
		expect(expanded).toContain("Add caching");
		expect(expanded).not.toContain("$ARGUMENTS");
	});
});

describe("review-pr template", () => {
	const content = readFileSync(
		join(templatesDir, "review-pr.md"),
		"utf-8",
	);
	const template = parseCommandTemplate(content)!;

	it("has correct metadata", () => {
		expect(template.name).toBe("review-pr");
		expect(template.description).toContain("PR review");
	});

	it("contains $ARGUMENTS placeholder", () => {
		expect(template.prompt).toContain("$ARGUMENTS");
	});

	it("references sub-agents", () => {
		expect(template.prompt).toContain("comment-analyzer");
		expect(template.prompt).toContain("pr-test-analyzer");
		expect(template.prompt).toContain("silent-failure-hunter");
		expect(template.prompt).toContain("type-design-analyzer");
		expect(template.prompt).toContain("code-reviewer");
		expect(template.prompt).toContain("code-simplifier");
	});

	it("defines review aspects", () => {
		const aspects = [
			"comments",
			"tests",
			"errors",
			"types",
			"code",
			"simplify",
		];
		for (const aspect of aspects) {
			expect(template.prompt).toContain(`**${aspect}**`);
		}
	});

	it("has aggregation format", () => {
		expect(template.prompt).toContain("Critical Issues");
		expect(template.prompt).toContain("Important Issues");
		expect(template.prompt).toContain("Suggestions");
	});
});

describe("registerCommands", () => {
	it("calls pi.registerCommand for each template", async () => {
		// Dynamically import the module to test registration
		const { registerCommands } = await import(
			"../../src/commands/registry.js"
		);

		const registered: Array<{
			name: string;
			options: { description: string };
		}> = [];

		const mockPi = {
			registerCommand: vi.fn(
				(name: string, options: { description: string }) => {
					registered.push({ name, options });
				},
			),
			sendUserMessage: vi.fn(),
		};

		registerCommands(mockPi as any);

		expect(mockPi.registerCommand).toHaveBeenCalledTimes(3);

		const names = registered.map((r) => r.name);
		expect(names).toContain("feature-dev");
		expect(names).toContain("review-pr");
		expect(names).toContain("agents");
	});

	it("skips registration if pi.registerCommand is not available", async () => {
		const { registerCommands } = await import(
			"../../src/commands/registry.js"
		);

		const mockPi = {};

		// Should not throw
		expect(() => registerCommands(mockPi as any)).not.toThrow();
	});
});
