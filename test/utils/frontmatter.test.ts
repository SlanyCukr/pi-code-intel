import { describe, it, expect } from "vitest";
import {
	getFrontmatterArray,
	getFrontmatterString,
	parseFrontmatter,
} from "../../src/utils/frontmatter.js";

describe("parseFrontmatter", () => {
	it("parses valid content with frontmatter", () => {
		const content = "---\nname: my-template\nmodel: sonnet\n---\n# Body content here";
		const result = parseFrontmatter(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toBe("name: my-template\nmodel: sonnet");
		expect(result!.body).toBe("# Body content here");
	});

	it("returns null when content has no frontmatter delimiters", () => {
		const content = "# Just a markdown file\nNo frontmatter here.";
		expect(parseFrontmatter(content)).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseFrontmatter("")).toBeNull();
	});

	it("returns empty body string when body is empty after delimiter", () => {
		const content = "---\nname: test\n---\n";
		const result = parseFrontmatter(content);
		expect(result).not.toBeNull();
		expect(result!.body).toBe("");
	});

	it("parses multiline frontmatter with multiple keys", () => {
		const content = "---\nname: code-explorer\ncategory: feature-dev\ndescription: Explores codebase\nmodel: inherit\nthinkingLevel: low\ntools: [read, bash, lsp]\n---\n# System prompt\nDo stuff.";
		const result = parseFrontmatter(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toContain("name: code-explorer");
		expect(result!.frontmatter).toContain("tools: [read, bash, lsp]");
		expect(result!.body).toBe("# System prompt\nDo stuff.");
	});
});

describe("getFrontmatterString", () => {
	it("returns value for an existing key", () => {
		const frontmatter = "name: my-template\nmodel: sonnet";
		expect(getFrontmatterString(frontmatter, "name")).toBe("my-template");
		expect(getFrontmatterString(frontmatter, "model")).toBe("sonnet");
	});

	it("returns undefined for a missing key", () => {
		const frontmatter = "name: my-template";
		expect(getFrontmatterString(frontmatter, "description")).toBeUndefined();
	});

	it("strips surrounding double quotes from value", () => {
		const frontmatter = 'description: "A quoted description"';
		expect(getFrontmatterString(frontmatter, "description")).toBe("A quoted description");
	});

	it("strips surrounding single quotes from value", () => {
		const frontmatter = "description: 'A single-quoted value'";
		expect(getFrontmatterString(frontmatter, "description")).toBe("A single-quoted value");
	});

	it("trims whitespace from value", () => {
		const frontmatter = "name:   spaced-value  ";
		expect(getFrontmatterString(frontmatter, "name")).toBe("spaced-value");
	});

	it("only strips matching leading/trailing quote pairs", () => {
		// Mixed quotes — leave value untouched (don't silently strip both).
		expect(getFrontmatterString("description: 'foo\"", "description")).toBe("'foo\"");
		expect(getFrontmatterString('description: "foo\'', "description")).toBe('"foo\'');
		// Unbalanced (only leading) — leave untouched.
		expect(getFrontmatterString("name: \"foo", "name")).toBe('"foo');
		expect(getFrontmatterString("name: foo\"", "name")).toBe('foo"');
	});

	it("escapes regex metacharacters in the key", () => {
		// Without escaping, `.` would match any character and produce a false
		// positive against an unrelated key.
		const frontmatter = "foo.bar: real\nfooxbar: bogus";
		expect(getFrontmatterString(frontmatter, "foo.bar")).toBe("real");
	});
});

describe("getFrontmatterArray", () => {
	it("returns items for an existing array key", () => {
		const frontmatter = "tools: [read, bash, lsp]";
		expect(getFrontmatterArray(frontmatter, "tools")).toEqual(["read", "bash", "lsp"]);
	});

	it("returns empty array for a missing key", () => {
		const frontmatter = "name: my-template";
		expect(getFrontmatterArray(frontmatter, "tools")).toEqual([]);
	});

	it("trims whitespace from each array item", () => {
		const frontmatter = "tools: [ read , bash , lsp ]";
		expect(getFrontmatterArray(frontmatter, "tools")).toEqual(["read", "bash", "lsp"]);
	});

	it("returns empty array for malformed array without closing bracket", () => {
		const frontmatter = "tools: [read, bash";
		expect(getFrontmatterArray(frontmatter, "tools")).toEqual([]);
	});

	it("escapes regex metacharacters in the key", () => {
		const frontmatter = "foo.bar: [a, b]\nfooxbar: [c, d]";
		expect(getFrontmatterArray(frontmatter, "foo.bar")).toEqual(["a", "b"]);
	});
});
