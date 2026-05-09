import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { LspClientManager } from "./client.js";
import type {
	CallHierarchyIncomingCall,
	CallHierarchyItem,
	CallHierarchyOutgoingCall,
	CodeAction,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	Position,
	SymbolInformation,
	WorkspaceEdit,
} from "./types.js";
import {
	fileToUri,
	formatCallHierarchyIncoming,
	formatCallHierarchyOutgoing,
	formatDiagnostics,
	formatDocumentSymbols,
	formatHover,
	formatLocationWithContext,
	formatLocations,
	formatWorkspaceSymbols,
	resolveSymbolPosition,
} from "./utils.js";

const lspSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("definition"),
				Type.Literal("type_definition"),
				Type.Literal("implementation"),
				Type.Literal("references"),
				Type.Literal("hover"),
				Type.Literal("diagnostics"),
				Type.Literal("document_symbols"),
				Type.Literal("workspace_symbols"),
				Type.Literal("incoming_calls"),
				Type.Literal("outgoing_calls"),
				Type.Literal("rename"),
				Type.Literal("code_actions"),
				Type.Literal("status"),
				Type.Literal("reload"),
			],
			{
				description:
					"The LSP operation to perform",
			},
		),
		file: Type.Optional(
			Type.String({
				description:
					"File path (relative or absolute). Required for every action except 'status' and 'reload'. For 'workspace_symbols' the file selects which LSP server to query.",
			}),
		),
		line: Type.Optional(
			Type.Number({
				description:
					"1-based line number in the file. Required for position-based actions: hover, definition, type_definition, implementation, references, incoming_calls, outgoing_calls, rename, code_actions.",
			}),
		),
		symbol: Type.Optional(
			Type.String({
				description:
					"Symbol name at the line to target. Helps disambiguate when multiple symbols exist on the same line.",
			}),
		),
		query: Type.Optional(
			Type.String({
				description:
					"Search query for workspace_symbols. Required for the 'workspace_symbols' action.",
			}),
		),
		new_name: Type.Optional(
			Type.String({
				description:
					"New name for the rename action.",
			}),
		),
	},
	{ additionalProperties: false },
);

type LspInput = Static<typeof lspSchema>;

export const LSP_TOOL_NAME = "lsp";

const LSP_DESCRIPTION = `Language Server Protocol tool for code intelligence operations.

\`symbol\` is always an optional disambiguator on position-based actions:
when given, the column is set to the first occurrence of \`symbol\` on
the line; when omitted, the column falls back to 0 and the LSP server
resolves the nearest token itself.

Actions:
- definition: Go to definition of a symbol (requires file, line)
- type_definition: Go to type definition (requires file, line)
- implementation: Find implementations of an interface/abstract (requires file, line)
- references: Find all references to a symbol (requires file, line)
- hover: Get type info and documentation for a symbol (requires file, line)
- diagnostics: Get compiler errors/warnings (requires file)
- document_symbols: List all symbols in a file (requires file)
- workspace_symbols: Search for symbols across the workspace (requires file, query)
- incoming_calls: Find all callers of a function (requires file, line)
- outgoing_calls: Find all functions called by a function (requires file, line)
- rename: Rename a symbol across the codebase (requires file, line, new_name)
- code_actions: Get available code fixes/refactors at a location (requires file, line)
- status: Show which LSP servers are running
- reload: Restart all LSP servers`;

export function createLspTool(
	manager: LspClientManager,
	cwd: string,
): ToolDefinition<typeof lspSchema> {
	return {
		name: LSP_TOOL_NAME,
		label: "LSP",
		description: LSP_DESCRIPTION,
		parameters: lspSchema,
		async execute(_toolCallId, input, signal) {
			const result = await executeLspAction(manager, cwd, input, signal);
			return {
				content: [{ type: "text" as const, text: result }],
				details: undefined,
			};
		},
	};
}

async function executeLspAction(
	manager: LspClientManager,
	cwd: string,
	input: LspInput,
	signal?: AbortSignal,
): Promise<string> {
	const { action } = input;

	// Actions that don't need a file
	if (action === "status") {
		const servers = manager.getActiveServers();
		if (servers.length === 0) return "No LSP servers are currently running.";
		return `Active LSP servers:\n${servers.map((s) => `  - ${s}`).join("\n")}`;
	}

	if (action === "reload") {
		await manager.restart();
		return "All LSP servers have been shut down and cached state cleared. They will be re-spawned on the next tool call.";
	}

	if (action === "workspace_symbols") {
		if (!input.query) throw new Error("query is required for workspace_symbols");
		if (!input.file)
			throw new Error("file is required for workspace_symbols (to determine which LSP server to use)");
		const absFile = resolve(cwd, input.file);
		const client = await manager.getClientForFile(absFile, signal);
		if (!client) return `No LSP server available for ${input.file}`;

		const symbols = (await manager.sendRequest(
			client,
			"workspace/symbol",
			{ query: input.query },
			signal,
		)) as SymbolInformation[] | null;

		return formatWorkspaceSymbols(symbols ?? [], cwd);
	}

	// All other actions need a file
	if (!input.file) throw new Error(`file is required for ${action}`);
	const filePath = resolve(cwd, input.file);

	const client = await manager.getClientForFile(filePath, signal);
	if (!client) return `No LSP server available for ${input.file}`;

	// Sync the file before making requests
	await manager.syncFile(client, filePath);

	const uri = fileToUri(filePath);

	// Position-based actions share the same setup
	const POSITION_ACTIONS = new Set([
		"hover", "definition", "type_definition", "implementation",
		"references", "incoming_calls", "outgoing_calls", "rename", "code_actions",
	]);

	let pos: Position | undefined;
	if (POSITION_ACTIONS.has(action)) {
		if (!input.line) throw new Error(`line is required for ${action}`);
		pos = resolveSymbolPosition(filePath, input.line, input.symbol);
	}

	const DIAGNOSTICS_SETTLE_MS = 500;

	switch (action) {
		case "diagnostics": {
			await new Promise((r) => setTimeout(r, DIAGNOSTICS_SETTLE_MS));
			const diags = manager.getDiagnostics(client, filePath);
			return formatDiagnostics(diags, cwd);
		}

		case "document_symbols": {
			const symbols = (await manager.sendRequest(
				client,
				"textDocument/documentSymbol",
				{ textDocument: { uri } },
				signal,
			)) as DocumentSymbol[] | null;

			return formatDocumentSymbols(symbols ?? []);
		}

		case "hover": {
			const hover = (await manager.sendRequest(
				client,
				"textDocument/hover",
				{ textDocument: { uri }, position: pos! },
				signal,
			)) as Hover | null;

			return formatHover(hover);
		}

		case "definition":
		case "type_definition":
		case "implementation": {
			const methodMap = {
				definition: "textDocument/definition",
				type_definition: "textDocument/typeDefinition",
				implementation: "textDocument/implementation",
			};

			const result = (await manager.sendRequest(
				client,
				methodMap[action],
				{ textDocument: { uri }, position: pos! },
				signal,
			)) as Location | Location[] | LocationLink[] | null;

			if (!result) return "No results found.";
			const locations = Array.isArray(result) ? result : [result];
			if (locations.length === 0) return "No results found.";

			if (locations.length <= 5) {
				return locations
					.map((loc) => formatLocationWithContext(loc, cwd))
					.join("\n\n");
			}
			return formatLocations(locations, cwd);
		}

		case "references": {
			const refs = (await manager.sendRequest(
				client,
				"textDocument/references",
				{
					textDocument: { uri },
					position: pos!,
					context: { includeDeclaration: true },
				},
				signal,
			)) as Location[] | null;

			return formatLocations(refs ?? [], cwd);
		}

		case "incoming_calls":
		case "outgoing_calls": {
			const items = (await manager.sendRequest(
				client,
				"textDocument/prepareCallHierarchy",
				{ textDocument: { uri }, position: pos! },
				signal,
			)) as CallHierarchyItem[] | null;

			if (!items || items.length === 0)
				return "Could not resolve call hierarchy at this location.";

			const item = items[0];

			const callMethodMap = {
				incoming_calls: "callHierarchy/incomingCalls",
				outgoing_calls: "callHierarchy/outgoingCalls",
			} as const;
			const calls = (await manager.sendRequest(
				client,
				callMethodMap[action],
				{ item },
				signal,
			)) as (CallHierarchyIncomingCall | CallHierarchyOutgoingCall)[] | null;

			if (action === "incoming_calls") {
				return `Incoming calls to ${item.name}:\n${formatCallHierarchyIncoming((calls ?? []) as CallHierarchyIncomingCall[], cwd)}`;
			} else {
				return `Outgoing calls from ${item.name}:\n${formatCallHierarchyOutgoing((calls ?? []) as CallHierarchyOutgoingCall[], cwd)}`;
			}
		}

		case "rename": {
			if (!input.new_name) throw new Error("new_name is required for rename");

			const edit = (await manager.sendRequest(
				client,
				"textDocument/rename",
				{
					textDocument: { uri },
					position: pos!,
					newName: input.new_name,
				},
				signal,
			)) as WorkspaceEdit | null;

			if (!edit) return "Rename not supported at this location.";

			let fileCount = 0;
			if (edit.changes) {
				fileCount = Object.keys(edit.changes).length;
			} else if (edit.documentChanges) {
				fileCount = edit.documentChanges.length;
			}

			return `Rename would affect ${fileCount} file(s). Note: The rename edit was computed but not applied. Use the edit tool to apply changes manually.`;
		}

		case "code_actions": {
			const fileDiags = manager.getDiagnostics(client, filePath);
			const lineDiags: Diagnostic[] = [];
			for (const diags of fileDiags.values()) {
				for (const d of diags) {
					if (d.range.start.line === pos!.line) {
						lineDiags.push(d);
					}
				}
			}

			const actions = (await manager.sendRequest(
				client,
				"textDocument/codeAction",
				{
					textDocument: { uri },
					range: { start: pos!, end: pos! },
					context: { diagnostics: lineDiags },
				},
				signal,
			)) as CodeAction[] | null;

			if (!actions || actions.length === 0)
				return "No code actions available at this location.";

			return actions
				.map((a, i) => {
					const kind = a.kind ? ` [${a.kind}]` : "";
					const preferred = a.isPreferred ? " (preferred)" : "";
					return `  ${i + 1}. ${a.title}${kind}${preferred}`;
				})
				.join("\n");
		}

		default:
			return `Unknown action: ${action}`;
	}
}
