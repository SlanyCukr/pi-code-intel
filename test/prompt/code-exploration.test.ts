import { describe, it, expect } from "vitest";
import { buildCodeExplorationGuidance } from "../../src/prompt/code-exploration.js";

describe("buildCodeExplorationGuidance", () => {
	it("returns null when both hasLsp and hasSearch are false", () => {
		expect(buildCodeExplorationGuidance(false, false)).toBeNull();
	});

	describe("hasLsp=true, hasSearch=true", () => {
		const result = buildCodeExplorationGuidance(true, true)!;

		it("returns a non-null string", () => {
			expect(result).not.toBeNull();
			expect(typeof result).toBe("string");
		});

		it("includes combined core rule", () => {
			expect(result).toContain("search_code discovers, lsp explains");
		});

		it("includes read budget", () => {
			expect(result).toContain("Read budget");
			expect(result).toContain(
				"Maximum 1 read before the first LSP call",
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

		it("includes mandatory navigation triggers", () => {
			expect(result).toContain("Mandatory navigation triggers");
			expect(result).toContain("Where is this defined?");
			expect(result).toContain("Who calls this function?");
		});

		it("includes tool selection hierarchy with both search and LSP rows", () => {
			expect(result).toContain("Tool selection hierarchy");
			expect(result).toContain(
				"Find code related to a concept",
			);
			expect(result).toContain("search_code");
			expect(result).toContain("lsp definition or workspace_symbols");
			expect(result).toContain("lsp references");
			expect(result).toContain("lsp incoming_calls");
			expect(result).toContain("lsp outgoing_calls");
			expect(result).toContain("search_docs");
		});

		it("includes anti-patterns", () => {
			expect(result).toContain("Anti-patterns");
			expect(result).toContain(
				"Do NOT use document_symbols as proof",
			);
		});

		it("includes pre-tool checkpoint", () => {
			expect(result).toContain("Pre-tool checkpoint");
			expect(result).toContain(
				"Could search_code or lsp answer this in one call",
			);
		});
	});

	describe("hasLsp=true, hasSearch=false", () => {
		const result = buildCodeExplorationGuidance(true, false)!;

		it("returns a non-null string", () => {
			expect(result).not.toBeNull();
		});

		it("includes LSP-only core rule", () => {
			expect(result).toContain(
				"Use LSP for structural code navigation",
			);
		});

		it("includes read budget", () => {
			expect(result).toContain("Read budget");
		});

		it("includes navigation chain", () => {
			expect(result).toContain("Navigation chain");
		});

		it("includes anchor discipline", () => {
			expect(result).toContain("Anchor discipline");
		});

		it("includes anti-patterns", () => {
			expect(result).toContain("Anti-patterns");
		});

		it("does NOT include search_code rows in tool selection hierarchy", () => {
			expect(result).not.toContain("Find code related to a concept");
			expect(result).not.toContain("search_docs");
		});

		it("includes LSP rows in tool selection hierarchy", () => {
			expect(result).toContain("lsp definition or workspace_symbols");
			expect(result).toContain("lsp references");
			expect(result).toContain("lsp incoming_calls");
			expect(result).toContain("lsp outgoing_calls");
		});

		it("does NOT include combined core rule", () => {
			expect(result).not.toContain("search_code discovers, lsp explains");
		});
	});

	describe("hasLsp=false, hasSearch=true", () => {
		const result = buildCodeExplorationGuidance(false, true)!;

		it("returns a non-null string", () => {
			expect(result).not.toBeNull();
		});

		it("includes search-only core rule", () => {
			expect(result).toContain(
				"Use search_code to find code by meaning",
			);
		});

		it("does NOT include LSP navigation chain", () => {
			expect(result).not.toContain("Navigation chain");
		});

		it("does NOT include anti-patterns", () => {
			expect(result).not.toContain("Anti-patterns");
		});

		it("does NOT include read budget", () => {
			expect(result).not.toContain("Read budget");
		});

		it("does NOT include anchor discipline", () => {
			expect(result).not.toContain("Anchor discipline");
		});

		it("includes search rows in tool selection hierarchy", () => {
			expect(result).toContain("Find code related to a concept");
			expect(result).toContain("search_docs");
		});

		it("does NOT include LSP rows in tool selection hierarchy", () => {
			expect(result).not.toContain("lsp definition or workspace_symbols");
			expect(result).not.toContain("lsp references");
			expect(result).not.toContain("lsp incoming_calls");
			expect(result).not.toContain("lsp outgoing_calls");
		});
	});

	describe("LSP-specific tool names", () => {
		it("includes all LSP operation names when hasLsp=true", () => {
			const result = buildCodeExplorationGuidance(true, false)!;
			expect(result).toContain("document_symbols");
			expect(result).toContain("incoming_calls");
			expect(result).toContain("outgoing_calls");
			expect(result).toContain("definition");
			expect(result).toContain("references");
		});
	});

	describe("search-specific tool names", () => {
		it("includes search_code and search_docs when hasSearch=true", () => {
			const result = buildCodeExplorationGuidance(false, true)!;
			expect(result).toContain("search_code");
			expect(result).toContain("search_docs");
		});
	});
});
