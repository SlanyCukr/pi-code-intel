import { describe, it, expect } from "vitest";
import { buildCodeIntelPrompt } from "../../src/prompt/system-prompt.js";

describe("buildCodeIntelPrompt", () => {
	it("returns empty string when nothing is active", () => {
		expect(
			buildCodeIntelPrompt({
				hasLsp: false,
				hasSearch: false,
				hasAgent: false,
			}),
		).toBe("");
	});

	it("includes workflow table when LSP is active", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: true,
			hasSearch: false,
			hasAgent: false,
		});
		expect(result).toContain("Tool selection hierarchy");
		expect(result).toContain("lsp definition");
		expect(result).not.toContain("Sub-agent delegation");
	});

	it("includes workflow table when search is active", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: false,
			hasSearch: true,
			hasAgent: false,
		});
		expect(result).toContain("Tool selection hierarchy");
		expect(result).toContain("search_code");
	});

	it("includes sub-agent guidance when agent is active", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: false,
			hasSearch: false,
			hasAgent: true,
		});
		expect(result).toContain("Sub-agent delegation");
		expect(result).not.toContain("Tool selection hierarchy");
	});

	it("includes both sections when all active", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: true,
			hasSearch: true,
			hasAgent: true,
		});
		expect(result).toContain("Tool selection hierarchy");
		expect(result).toContain("Sub-agent delegation");
		expect(result).toContain("search_code");
		expect(result).toContain("lsp definition");
		expect(result).toContain("lsp references");
		expect(result).toContain("lsp incoming_calls");
		expect(result).toContain("search_docs");
	});

	it("workflow table has correct RIGHT choices", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: true,
			hasSearch: true,
			hasAgent: false,
		});
		// Verify key mappings
		expect(result).toContain("Find code related to a concept");
		expect(result).toContain("Find where a symbol is defined");
		expect(result).toContain("lsp outgoing_calls");
		expect(result).toContain("lsp document_symbols");
	});

	it("includes pre-tool checkpoint", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: true,
			hasSearch: true,
			hasAgent: false,
		});
		expect(result).toContain("Pre-tool checkpoint");
		expect(result).toContain("Could search_code or lsp answer this");
	});

	it("includes when grep/find are right", () => {
		const result = buildCodeIntelPrompt({
			hasLsp: true,
			hasSearch: true,
			hasAgent: false,
		});
		expect(result).toContain("When grep/find ARE the right choice");
		expect(result).toContain("Exact text patterns");
	});
});
