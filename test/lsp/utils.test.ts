import { describe, it, expect } from "vitest";
import {
	fileToUri,
	uriToFile,
	getLanguageId,
	formatLocation,
	formatLocations,
	formatDiagnostic,
	formatDiagnostics,
	formatDocumentSymbol,
	formatDocumentSymbols,
	formatWorkspaceSymbols,
	formatHover,
	formatCallHierarchyIncoming,
	formatCallHierarchyOutgoing,
	resolveSymbolPosition,
} from "../../src/lsp/utils.js";
import { DiagnosticSeverity, SymbolKind } from "../../src/lsp/types.js";

describe("fileToUri", () => {
	it("converts absolute Unix path", () => {
		expect(fileToUri("/home/user/file.ts")).toBe("file:///home/user/file.ts");
	});

	it("converts path with spaces", () => {
		expect(fileToUri("/home/user/my project/file.ts")).toBe(
			"file:///home/user/my project/file.ts",
		);
	});
});

describe("uriToFile", () => {
	it("converts file URI to path", () => {
		expect(uriToFile("file:///home/user/file.ts")).toBe(
			"/home/user/file.ts",
		);
	});

	it("decodes percent-encoded characters", () => {
		expect(uriToFile("file:///home/user/my%20project/file.ts")).toBe(
			"/home/user/my project/file.ts",
		);
	});

	it("returns non-file URIs unchanged", () => {
		expect(uriToFile("https://example.com")).toBe("https://example.com");
	});
});

describe("getLanguageId", () => {
	it("returns typescript for .ts", () => {
		expect(getLanguageId("foo.ts")).toBe("typescript");
	});

	it("returns typescriptreact for .tsx", () => {
		expect(getLanguageId("component.tsx")).toBe("typescriptreact");
	});

	it("returns python for .py", () => {
		expect(getLanguageId("script.py")).toBe("python");
	});

	it("returns rust for .rs", () => {
		expect(getLanguageId("main.rs")).toBe("rust");
	});

	it("returns null for unknown extensions", () => {
		expect(getLanguageId("file.xyz")).toBeNull();
	});

	it("handles full paths", () => {
		expect(getLanguageId("/home/user/project/src/main.go")).toBe("go");
	});
});

describe("formatLocation", () => {
	it("formats location with relative path", () => {
		const loc = {
			uri: "file:///home/user/project/src/file.ts",
			range: {
				start: { line: 9, character: 4 },
				end: { line: 9, character: 10 },
			},
		};
		expect(formatLocation(loc, "/home/user/project")).toBe(
			"src/file.ts:10:5",
		);
	});
});

describe("formatLocations", () => {
	it("returns message for empty array", () => {
		expect(formatLocations([], "/home")).toBe("No results found.");
	});

	it("formats single location", () => {
		const locs = [
			{
				uri: "file:///home/project/src/a.ts",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
			},
		];
		const result = formatLocations(locs, "/home/project");
		expect(result).toContain("1 result(s)");
		expect(result).toContain("src/a.ts:1:1");
	});

	it("groups by file for multiple files", () => {
		const locs = [
			{
				uri: "file:///p/a.ts",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
			{
				uri: "file:///p/b.ts",
				range: {
					start: { line: 5, character: 0 },
					end: { line: 5, character: 0 },
				},
			},
		];
		const result = formatLocations(locs, "/p");
		expect(result).toContain("2 files");
	});
});

describe("formatDiagnostic", () => {
	it("formats with all fields", () => {
		const diag = {
			range: {
				start: { line: 9, character: 4 },
				end: { line: 9, character: 10 },
			},
			severity: DiagnosticSeverity.Error,
			code: "TS2304",
			source: "typescript",
			message: "Cannot find name 'foo'",
		};
		const result = formatDiagnostic(diag, "/home/project/src/file.ts", "/home/project");
		expect(result).toBe(
			"src/file.ts:10:5 [error] [TS2304] (typescript): Cannot find name 'foo'",
		);
	});

	it("handles missing optional fields", () => {
		const diag = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 },
			},
			message: "Something wrong",
		};
		const result = formatDiagnostic(diag, "/p/file.ts", "/p");
		expect(result).toBe("file.ts:1:1 [error]: Something wrong");
	});
});

describe("formatDiagnostics", () => {
	it("returns message for empty map", () => {
		expect(formatDiagnostics(new Map(), "/p")).toBe("No diagnostics.");
	});

	it("converts URI keys to file paths", () => {
		const map = new Map([
			[
				"file:///p/src/file.ts",
				[
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
						severity: DiagnosticSeverity.Warning,
						message: "Unused variable",
					},
				],
			],
		]);
		const result = formatDiagnostics(map, "/p");
		expect(result).toContain("src/file.ts");
		expect(result).toContain("1 diagnostic(s)");
		expect(result).toContain("warning");
	});

	it("sorts errors before warnings", () => {
		const map = new Map([
			[
				"file:///p/file.ts",
				[
					{
						range: {
							start: { line: 1, character: 0 },
							end: { line: 1, character: 0 },
						},
						severity: DiagnosticSeverity.Warning,
						message: "Warning first",
					},
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
						severity: DiagnosticSeverity.Error,
						message: "Error second",
					},
				],
			],
		]);
		const result = formatDiagnostics(map, "/p");
		const errorIdx = result.indexOf("Error second");
		const warnIdx = result.indexOf("Warning first");
		expect(errorIdx).toBeLessThan(warnIdx);
	});

	it("respects maxMessages", () => {
		const diags = Array.from({ length: 10 }, (_, i) => ({
			range: {
				start: { line: i, character: 0 },
				end: { line: i, character: 0 },
			},
			severity: DiagnosticSeverity.Error,
			message: `Error ${i}`,
		}));
		const map = new Map([["file:///p/file.ts", diags]]);
		const result = formatDiagnostics(map, "/p", 3);
		expect(result).toContain("showing first 3");
	});
});

describe("formatDocumentSymbol", () => {
	it("formats simple symbol", () => {
		const symbol = {
			name: "myFunction",
			kind: SymbolKind.Function,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 5, character: 0 },
			},
			selectionRange: {
				start: { line: 0, character: 9 },
				end: { line: 0, character: 19 },
			},
		};
		expect(formatDocumentSymbol(symbol)).toBe(
			"function myFunction (line 1)",
		);
	});

	it("formats with children and indentation", () => {
		const symbol = {
			name: "MyClass",
			kind: SymbolKind.Class,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 20, character: 0 },
			},
			selectionRange: {
				start: { line: 0, character: 6 },
				end: { line: 0, character: 13 },
			},
			children: [
				{
					name: "method",
					kind: SymbolKind.Method,
					range: {
						start: { line: 2, character: 0 },
						end: { line: 5, character: 0 },
					},
					selectionRange: {
						start: { line: 2, character: 2 },
						end: { line: 2, character: 8 },
					},
				},
			],
		};
		const result = formatDocumentSymbol(symbol);
		expect(result).toContain("class MyClass");
		expect(result).toContain("  method method");
	});
});

describe("formatDocumentSymbols", () => {
	it("returns message for empty array", () => {
		expect(formatDocumentSymbols([])).toBe("No symbols found.");
	});
});

describe("formatWorkspaceSymbols", () => {
	it("returns message for empty array", () => {
		expect(formatWorkspaceSymbols([], "/p")).toBe("No symbols found.");
	});

	it("formats symbols with container name", () => {
		const symbols = [
			{
				name: "myFunc",
				kind: SymbolKind.Function,
				location: {
					uri: "file:///p/src/utils.ts",
					range: {
						start: { line: 5, character: 0 },
						end: { line: 10, character: 0 },
					},
				},
				containerName: "utils",
			},
		];
		const result = formatWorkspaceSymbols(symbols, "/p");
		expect(result).toContain("function myFunc");
		expect(result).toContain("in utils");
		expect(result).toContain("src/utils.ts:6:1");
	});
});

describe("formatHover", () => {
	it("returns message for null", () => {
		expect(formatHover(null)).toBe("No hover information available.");
	});

	it("handles string content", () => {
		expect(formatHover({ contents: "hello world" })).toBe("hello world");
	});

	it("handles MarkupContent", () => {
		expect(
			formatHover({ contents: { kind: "markdown", value: "**bold**" } }),
		).toBe("**bold**");
	});

	it("returns message for empty content", () => {
		expect(formatHover({ contents: "" })).toBe(
			"No hover information available.",
		);
	});
});

describe("formatCallHierarchyIncoming", () => {
	it("returns message for empty array", () => {
		expect(formatCallHierarchyIncoming([], "/p")).toBe(
			"No incoming calls found.",
		);
	});

	it("formats incoming calls", () => {
		const calls = [
			{
				from: {
					name: "caller",
					kind: SymbolKind.Function,
					uri: "file:///p/src/a.ts",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 5, character: 0 },
					},
					selectionRange: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 6 },
					},
				},
				fromRanges: [],
			},
		];
		const result = formatCallHierarchyIncoming(calls, "/p");
		expect(result).toContain("function caller");
		expect(result).toContain("src/a.ts:1");
	});
});

describe("formatCallHierarchyOutgoing", () => {
	it("returns message for empty array", () => {
		expect(formatCallHierarchyOutgoing([], "/p")).toBe(
			"No outgoing calls found.",
		);
	});
});

describe("resolveSymbolPosition", () => {
	it("returns 0-based line with character 0 when no symbol", () => {
		const pos = resolveSymbolPosition("/nonexistent", 5);
		expect(pos.line).toBe(4);
		expect(pos.character).toBe(0);
	});
});
