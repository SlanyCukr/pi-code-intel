import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
	type CallHierarchyIncomingCall,
	type CallHierarchyOutgoingCall,
	type Diagnostic,
	DiagnosticSeverity,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type MarkupContent,
	type Position,
	SymbolKind,
	type SymbolInformation,
} from "./types.js";

// URI <-> Path conversion

export function fileToUri(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	if (normalized.startsWith("/")) {
		return `file://${normalized}`;
	}
	// Windows: C:\foo -> file:///C:/foo
	return `file:///${normalized}`;
}

export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	let path = uri.slice(7);
	// file:///C:/foo -> C:/foo (Windows)
	if (path.match(/^\/[a-zA-Z]:\//)) {
		path = path.slice(1);
	}
	return decodeURIComponent(path);
}

// Language ID detection

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".scala": "scala",
	".rb": "ruby",
	".php": "php",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".cs": "csharp",
	".fs": "fsharp",
	".hs": "haskell",
	".ml": "ocaml",
	".mli": "ocaml",
	".ex": "elixir",
	".exs": "elixir",
	".erl": "erlang",
	".hrl": "erlang",
	".lua": "lua",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".dart": "dart",
	".swift": "swift",
	".zig": "zig",
	".nim": "nim",
	".vue": "vue",
	".svelte": "svelte",
	".astro": "astro",
	".html": "html",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".xml": "xml",
	".sql": "sql",
	".graphql": "graphql",
	".gql": "graphql",
	".proto": "protobuf",
	".tf": "terraform",
	".nix": "nix",
	".md": "markdown",
	".tex": "latex",
	".r": "r",
	".R": "r",
	".jl": "julia",
	".gleam": "gleam",
	".odin": "odin",
};

export function getLanguageId(filePath: string): string | null {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// Formatting functions

export function formatLocation(loc: Location, cwd: string): string {
	const file = relative(cwd, uriToFile(loc.uri));
	const line = loc.range.start.line + 1;
	const col = loc.range.start.character + 1;
	return `${file}:${line}:${col}`;
}

export function formatLocations(
	locations: (Location | LocationLink)[],
	cwd: string,
): string {
	if (locations.length === 0) return "No results found.";

	const formatted = locations.map((loc) => {
		if ("targetUri" in loc) {
			// LocationLink
			const file = relative(cwd, uriToFile(loc.targetUri));
			const line = loc.targetSelectionRange.start.line + 1;
			const col = loc.targetSelectionRange.start.character + 1;
			return `  ${file}:${line}:${col}`;
		}
		return `  ${formatLocation(loc, cwd)}`;
	});

	// Group by file
	const grouped = new Map<string, string[]>();
	for (const line of formatted) {
		const file = line.trim().split(":")[0];
		if (!grouped.has(file)) grouped.set(file, []);
		grouped.get(file)!.push(line);
	}

	if (grouped.size === 1) {
		return `Found ${locations.length} result(s):\n${formatted.join("\n")}`;
	}

	const parts: string[] = [];
	for (const [file, lines] of grouped) {
		parts.push(`${file}:\n${lines.join("\n")}`);
	}
	return `Found ${locations.length} result(s) in ${grouped.size} files:\n${parts.join("\n")}`;
}

export function formatLocationWithContext(
	loc: Location | LocationLink,
	cwd: string,
	contextLines = 2,
): string {
	const uri = "targetUri" in loc ? loc.targetUri : loc.uri;
	const range = "targetRange" in loc ? loc.targetRange : loc.range;
	const filePath = uriToFile(uri);
	const relPath = relative(cwd, filePath);

	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const startLine = Math.max(0, range.start.line - contextLines);
		const endLine = Math.min(
			lines.length - 1,
			range.end.line + contextLines,
		);

		const snippet = lines
			.slice(startLine, endLine + 1)
			.map((line, i) => {
				const lineNum = startLine + i + 1;
				const marker =
					lineNum >= range.start.line + 1 &&
					lineNum <= range.end.line + 1
						? ">"
						: " ";
				return `${marker} ${String(lineNum).padStart(4)} │ ${line}`;
			})
			.join("\n");

		return `${relPath}:${range.start.line + 1}:${range.start.character + 1}\n${snippet}`;
	} catch {
		return `${relPath}:${range.start.line + 1}:${range.start.character + 1}`;
	}
}

const SEVERITY_LABELS: Record<number, string> = {
	[DiagnosticSeverity.Error]: "error",
	[DiagnosticSeverity.Warning]: "warning",
	[DiagnosticSeverity.Information]: "info",
	[DiagnosticSeverity.Hint]: "hint",
};

export function formatDiagnostic(
	diag: Diagnostic,
	filePath: string,
	cwd: string,
): string {
	const file = relative(cwd, filePath);
	const line = diag.range.start.line + 1;
	const col = diag.range.start.character + 1;
	const severity = SEVERITY_LABELS[diag.severity ?? 1] ?? "error";
	const source = diag.source ? ` (${diag.source})` : "";
	const code = diag.code ? ` [${diag.code}]` : "";
	return `${file}:${line}:${col} [${severity}]${code}${source}: ${diag.message}`;
}

export function formatDiagnostics(
	diagnosticsMap: Map<string, Diagnostic[]>,
	cwd: string,
	maxMessages = 50,
): string {
	const allDiags: { file: string; diag: Diagnostic }[] = [];
	for (const [uriOrPath, diags] of diagnosticsMap) {
		// Keys from LSP are URIs — convert to file paths
		const file = uriOrPath.startsWith("file://")
			? uriToFile(uriOrPath)
			: uriOrPath;
		for (const diag of diags) {
			allDiags.push({ file, diag });
		}
	}

	if (allDiags.length === 0) return "No diagnostics.";

	// Sort by severity (errors first), then by file
	allDiags.sort((a, b) => {
		const sevA = a.diag.severity ?? 1;
		const sevB = b.diag.severity ?? 1;
		if (sevA !== sevB) return sevA - sevB;
		return a.file.localeCompare(b.file);
	});

	const errorCount = allDiags.filter(
		(d) => (d.diag.severity ?? 1) === DiagnosticSeverity.Error,
	).length;
	const warnCount = allDiags.filter(
		(d) => d.diag.severity === DiagnosticSeverity.Warning,
	).length;

	const lines = allDiags
		.slice(0, maxMessages)
		.map((d) => formatDiagnostic(d.diag, d.file, cwd));

	let summary = `${allDiags.length} diagnostic(s)`;
	if (errorCount > 0) summary += `, ${errorCount} error(s)`;
	if (warnCount > 0) summary += `, ${warnCount} warning(s)`;
	if (allDiags.length > maxMessages) {
		summary += ` (showing first ${maxMessages})`;
	}

	return `${summary}:\n${lines.join("\n")}`;
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
	[SymbolKind.File]: "file",
	[SymbolKind.Module]: "module",
	[SymbolKind.Namespace]: "namespace",
	[SymbolKind.Package]: "package",
	[SymbolKind.Class]: "class",
	[SymbolKind.Method]: "method",
	[SymbolKind.Property]: "property",
	[SymbolKind.Field]: "field",
	[SymbolKind.Constructor]: "constructor",
	[SymbolKind.Enum]: "enum",
	[SymbolKind.Interface]: "interface",
	[SymbolKind.Function]: "function",
	[SymbolKind.Variable]: "variable",
	[SymbolKind.Constant]: "constant",
	[SymbolKind.String]: "string",
	[SymbolKind.Number]: "number",
	[SymbolKind.Boolean]: "boolean",
	[SymbolKind.Array]: "array",
	[SymbolKind.Object]: "object",
	[SymbolKind.Key]: "key",
	[SymbolKind.Null]: "null",
	[SymbolKind.EnumMember]: "enum member",
	[SymbolKind.Struct]: "struct",
	[SymbolKind.Event]: "event",
	[SymbolKind.Operator]: "operator",
	[SymbolKind.TypeParameter]: "type parameter",
};

function symbolKindName(kind: SymbolKind): string {
	return SYMBOL_KIND_NAMES[kind] ?? "symbol";
}

export function formatDocumentSymbol(
	symbol: DocumentSymbol,
	indent = 0,
): string {
	const prefix = "  ".repeat(indent);
	const kind = symbolKindName(symbol.kind);
	const detail = symbol.detail ? ` — ${symbol.detail}` : "";
	const line = symbol.selectionRange.start.line + 1;
	let result = `${prefix}${kind} ${symbol.name}${detail} (line ${line})`;

	if (symbol.children) {
		for (const child of symbol.children) {
			result += "\n" + formatDocumentSymbol(child, indent + 1);
		}
	}
	return result;
}

export function formatDocumentSymbols(symbols: DocumentSymbol[]): string {
	if (symbols.length === 0) return "No symbols found.";
	return symbols.map((s) => formatDocumentSymbol(s, 0)).join("\n");
}

export function formatWorkspaceSymbols(
	symbols: SymbolInformation[],
	cwd: string,
): string {
	if (symbols.length === 0) return "No symbols found.";

	return symbols
		.map((s) => {
			const kind = symbolKindName(s.kind);
			const loc = formatLocation(s.location, cwd);
			const container = s.containerName ? ` in ${s.containerName}` : "";
			return `  ${kind} ${s.name}${container} — ${loc}`;
		})
		.join("\n");
}

export function formatHover(hover: Hover | null): string {
	if (!hover) return "No hover information available.";

	if (typeof hover.contents === "string") {
		return hover.contents || "No hover information available.";
	}

	const content = (hover.contents as MarkupContent).value;
	return content || "No hover information available.";
}

export function formatCallHierarchyIncoming(
	calls: CallHierarchyIncomingCall[],
	cwd: string,
): string {
	if (calls.length === 0) return "No incoming calls found.";

	return calls
		.map((call) => {
			const kind = symbolKindName(call.from.kind);
			const file = relative(cwd, uriToFile(call.from.uri));
			const line = call.from.selectionRange.start.line + 1;
			const detail = call.from.detail ? ` — ${call.from.detail}` : "";
			return `  ${kind} ${call.from.name}${detail} at ${file}:${line}`;
		})
		.join("\n");
}

export function formatCallHierarchyOutgoing(
	calls: CallHierarchyOutgoingCall[],
	cwd: string,
): string {
	if (calls.length === 0) return "No outgoing calls found.";

	return calls
		.map((call) => {
			const kind = symbolKindName(call.to.kind);
			const file = relative(cwd, uriToFile(call.to.uri));
			const line = call.to.selectionRange.start.line + 1;
			const detail = call.to.detail ? ` — ${call.to.detail}` : "";
			return `  ${kind} ${call.to.name}${detail} at ${file}:${line}`;
		})
		.join("\n");
}

export function resolveSymbolPosition(
	filePath: string,
	line: number,
	symbol?: string,
	occurrence = 1,
): Position {
	// line is 1-based from user, convert to 0-based
	const zeroLine = line - 1;

	if (!symbol) {
		return { line: zeroLine, character: 0 };
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		if (zeroLine >= 0 && zeroLine < lines.length) {
			const lineContent = lines[zeroLine];
			let found = 0;
			let idx = -1;
			while (found < occurrence) {
				idx = lineContent.indexOf(symbol, idx + 1);
				if (idx === -1) break;
				found++;
			}
			if (idx !== -1) {
				return { line: zeroLine, character: idx };
			}
		}
	} catch {
		// Fall through to default
	}

	return { line: zeroLine, character: 0 };
}
