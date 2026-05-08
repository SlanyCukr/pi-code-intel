import { describe, it, expect, beforeEach } from "vitest";
import { readAfterDocumentSymbols } from "../../../src/analysis/patterns/read-after-document-symbols.js";
import {
	makeSession,
	resetLineCounter,
	tcBash,
	tcLsp,
	tcRead,
} from "./helpers.js";

describe("readAfterDocumentSymbols", () => {
	beforeEach(() => resetLineCounter());

	it("flags whole-file read immediately after document_symbols on same file", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			ruleId: "read-after-document-symbols",
			lineRange: [2, 3],
		});
	});

	it("does NOT flag a targeted read with small limit", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcRead("src/x.ts", { offset: 50, limit: 30 }),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("flags a read with limit > whole-file threshold (200)", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcRead("src/x.ts", { limit: 500 }),
			]),
		);
		expect(hits).toHaveLength(1);
	});

	it("does not flag when read is for a different file", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcRead("src/y.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("looks ahead through up to 5 tool calls", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcBash("ls"),
				tcBash("ls"),
				tcBash("ls"),
				tcBash("ls"),
				tcRead("src/x.ts"), // 5th tool call after — still within window
			]),
		);
		expect(hits).toHaveLength(1);
	});

	it("does NOT flag a read more than 5 tool calls after document_symbols", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcBash("ls"),
				tcBash("ls"),
				tcBash("ls"),
				tcBash("ls"),
				tcBash("ls"),
				tcRead("src/x.ts"), // 6th tool call — outside window
			]),
		);
		expect(hits).toEqual([]);
	});

	it("does not flag non-document_symbols lsp actions", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("definition", { file: "src/x.ts" }),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("only fires once per document_symbols even if multiple reads follow", () => {
		const hits = readAfterDocumentSymbols(
			makeSession([
				tcLsp("document_symbols", { file: "src/x.ts" }),
				tcRead("src/x.ts"),
				tcRead("src/x.ts"),
			]),
		);
		// Just one hit from this rule. read-twice-no-edit catches the second.
		expect(hits).toHaveLength(1);
	});
});
