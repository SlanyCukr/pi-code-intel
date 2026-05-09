import { readFileSync } from "node:fs";
import { extname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	CallHierarchyIncomingCall,
	CallHierarchyOutgoingCall,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	MarkedString,
	Position,
	SymbolInformation,
} from "./types.js";
import { DiagnosticSeverity, SymbolKind } from "./types.js";

// URI <-> Path conversion. Node's stdlib does the RFC 3986 work correctly
// (percent-encoding spaces / `#` / `?` / `%` / non-ASCII, Windows drive
// letters); the prior hand-rolled versions did not.

export function fileToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	return fileURLToPath(uri);
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
	const ext = extname(filePath);
	if (!ext) return null;
	return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// Formatting functions

export function formatLocation(loc: Location, cwd: string): string {
	const file = relative(cwd, uriToFile(loc.uri));
	const line = loc.range.start.line + 1;
	const col = loc.range.start.character + 1;
	return `${file}:${line}:${col}`;
}

function formatSingleLocation(loc: Location | LocationLink, cwd: string): string {
	if ("targetUri" in loc) {
		const file = relative(cwd, uriToFile(loc.targetUri));
		const line = loc.targetSelectionRange.start.line + 1;
		const col = loc.targetSelectionRange.start.character + 1;
		return `${file}:${line}:${col}`;
	}
	return formatLocation(loc, cwd);
}

export function formatLocations(
	locations: (Location | LocationLink)[],
	cwd: string,
): string {
	if (locations.length === 0) return "No results found.";

	// Group raw locations by relative file path first, then format each group.
	const grouped = new Map<string, (Location | LocationLink)[]>();
	for (const loc of locations) {
		const file = relative(cwd, uriToFile("targetUri" in loc ? loc.targetUri : loc.uri));
		if (!grouped.has(file)) grouped.set(file, []);
		grouped.get(file)!.push(loc);
	}

	if (grouped.size === 1) {
		const [, locs] = [...grouped][0];
		const lines = locs.map((loc) => `  ${formatSingleLocation(loc, cwd)}`);
		return `Found ${locations.length} result(s):\n${lines.join("\n")}`;
	}

	const parts: string[] = [];
	for (const [file, locs] of grouped) {
		const lines = locs.map((loc) => `  ${formatSingleLocation(loc, cwd)}`);
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

const MAX_DIAGNOSTIC_MESSAGES = 50;

export function formatDiagnostics(
	diagnosticsMap: Map<string, Diagnostic[]>,
	cwd: string,
): string {
	const maxMessages = MAX_DIAGNOSTIC_MESSAGES;
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

function formatMarkedString(m: MarkedString): string {
	if (typeof m === "string") return m;
	// `{ language, value }` form — render as a fenced code block.
	return `\`\`\`${m.language}\n${m.value}\n\`\`\``;
}

export function formatHover(hover: Hover | null): string {
	const NONE = "No hover information available.";
	if (!hover) return NONE;

	if (typeof hover.contents === "string") {
		return hover.contents || NONE;
	}

	if (Array.isArray(hover.contents)) {
		const parts = hover.contents
			.map(formatMarkedString)
			.filter((s) => s.length > 0);
		return parts.length > 0 ? parts.join("\n\n") : NONE;
	}

	// Discriminate single-object MarkedString (`{ language, value }`) from
	// MarkupContent (`{ kind, value }`). Both have `.value` so a structural
	// check on `language` is the cheapest disambiguation.
	if ("language" in hover.contents) {
		return formatMarkedString(hover.contents) || NONE;
	}
	return hover.contents.value || NONE;
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
): Position {
	// line is 1-based from user, convert to 0-based
	const zeroLine = line - 1;
	const fallback: Position = { line: zeroLine, character: 0 };

	if (!symbol) {
		return fallback;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		if (zeroLine >= 0 && zeroLine < lines.length) {
			const idx = lines[zeroLine].indexOf(symbol);
			if (idx !== -1) {
				return { line: zeroLine, character: idx };
			}
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.error(`[lsp] resolveSymbolPosition: failed to read ${filePath}:`, err instanceof Error ? err.message : err);
		}
	}

	return fallback;
}
