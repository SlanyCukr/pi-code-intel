import { describe, it, expect } from "vitest";
import { buildCodeExplorationGuidance } from "../../src/prompt/code-exploration.js";

describe("buildCodeExplorationGuidance", () => {
	it("returns null when hasLsp is false", () => {
		expect(buildCodeExplorationGuidance(false)).toBeNull();
	});

	describe("hasLsp=true", () => {
		const result = buildCodeExplorationGuidance(true)!;

		it("returns a non-null string", () => {
			expect(result).not.toBeNull();
			expect(typeof result).toBe("string");
		});

		it("includes LSP-only core rule", () => {
			expect(result).toContain(
				"Use LSP for structural code navigation",
			);
		});

		it("includes read budget", () => {
			expect(result).toContain("Read budget");
			expect(result).toContain(
				"navigating by brute force",
			);
		});

		it("includes LSP navigation chain", () => {
			expect(result).toContain("Navigation chain");
			expect(result).toContain(
				"document_symbols is reconnaissance",
			);
		});

		it("includes anchor discipline", () => {
			expect(result).toContain("Anchor discipline");
		});

		it("includes tool selection table with LSP operations", () => {
			expect(result).toContain("Tool selection");
			expect(result).toContain("Where is this defined?");
			expect(result).toContain("Who calls this function?");
			expect(result).toContain("definition");
			expect(result).toContain("incoming_calls");
			expect(result).toContain("outgoing_calls");
		});

		it("includes anti-patterns", () => {
			expect(result).toContain("Anti-patterns");
			expect(result).toContain(
				"Do NOT use document_symbols as proof",
			);
		});

		it("includes symbol-specific anti-grep rule pointing at workspace_symbols/references", () => {
			expect(result).toContain(
				"Do NOT use bash grep to locate symbol definitions or references",
			);
			expect(result).toContain("`workspace_symbols`");
			expect(result).toContain("`references`");
		});

		it("includes pre-tool checkpoint", () => {
			expect(result).toContain("Pre-tool checkpoint");
		});

		it("does not reference search_code or search_docs", () => {
			expect(result).not.toContain("search_code");
			expect(result).not.toContain("search_docs");
		});
	});

	describe("LSP-specific tool names", () => {
		it("includes all LSP operation names when hasLsp=true", () => {
			const result = buildCodeExplorationGuidance(true)!;
			expect(result).toContain("document_symbols");
			expect(result).toContain("incoming_calls");
			expect(result).toContain("outgoing_calls");
			expect(result).toContain("definition");
			expect(result).toContain("references");
		});
	});
});
