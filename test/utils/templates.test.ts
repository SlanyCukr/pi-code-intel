import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMarkdownDir } from "../../src/utils/templates.js";

describe("loadMarkdownDir", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for nonexistent directory", () => {
		const result = loadMarkdownDir("/nonexistent/path", () => ({ name: "x" }));
		expect(result).toEqual([]);
	});

	it("returns empty array for empty directory", () => {
		tempDir = mkdtempSync(join(tmpdir(), "templates-"));
		const result = loadMarkdownDir(tempDir, () => ({ name: "x" }));
		expect(result).toEqual([]);
	});

	it("skips non-md files", () => {
		tempDir = mkdtempSync(join(tmpdir(), "templates-"));
		writeFileSync(join(tempDir, "readme.txt"), "hello");
		writeFileSync(join(tempDir, "data.json"), "{}");
		const parse = vi.fn(() => ({ name: "x" }));
		const result = loadMarkdownDir(tempDir, parse);
		expect(parse).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("reads and parses .md files", () => {
		tempDir = mkdtempSync(join(tmpdir(), "templates-"));
		writeFileSync(join(tempDir, "one.md"), "# One");
		writeFileSync(join(tempDir, "two.md"), "# Two");
		const parse = vi.fn((content: string) => ({ title: content.trim() }));
		const result = loadMarkdownDir(tempDir, parse);
		expect(result).toHaveLength(2);
		expect(parse).toHaveBeenCalledTimes(2);
	});

	it("skips files where parse returns null", () => {
		tempDir = mkdtempSync(join(tmpdir(), "templates-"));
		writeFileSync(join(tempDir, "good.md"), "valid");
		writeFileSync(join(tempDir, "bad.md"), "invalid");
		const parse = vi.fn((content: string) =>
			content === "valid" ? { name: "good" } : null,
		);
		const result = loadMarkdownDir(tempDir, parse);
		expect(result).toEqual([{ name: "good" }]);
	});

	it("passes filename to parse function", () => {
		tempDir = mkdtempSync(join(tmpdir(), "templates-"));
		writeFileSync(join(tempDir, "test.md"), "content");
		const parse = vi.fn((_content: string, filename: string) => ({ filename }));
		loadMarkdownDir(tempDir, parse);
		expect(parse).toHaveBeenCalledWith("content", "test.md");
	});

	it("continues after parse error for individual file", () => {
		tempDir = mkdtempSync(join(tmpdir(), "templates-"));
		writeFileSync(join(tempDir, "a.md"), "good");
		// Create a subdirectory with .md name to cause readFileSync to fail
		mkdirSync(join(tempDir, "b.md"));
		writeFileSync(join(tempDir, "c.md"), "also good");
		const parse = vi.fn((content: string) => ({ content }));
		const result = loadMarkdownDir(tempDir, parse);
		// b.md is a directory, readFileSync will fail and it gets skipped
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});
