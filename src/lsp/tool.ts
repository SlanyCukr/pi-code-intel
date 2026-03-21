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
	uriToFile,
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
					"File path (relative or absolute). Required for most actions.",
			}),
		),
		line: Type.Optional(
			Type.Number({
				description:
					"1-based line number in the file. Required for position-based actions.",
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
					"Search query for workspace_symbols.",
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

const LSP_DESCRIPTION = `Language Server Protocol tool for code intelligence operations.

Actions:
- definition: Go to definition of a symbol (requires file, line, symbol)
- type_definition: Go to type definition (requires file, line, symbol)
- implementation: Find implementations of an interface/abstract (requires file, line, symbol)
- references: Find all references to a symbol (requires file, line, symbol)
- hover: Get type info and documentation for a symbol (requires file, line, symbol)
- diagnostics: Get compiler errors/warnings (requires file; omit file for workspace diagnostics)
- document_symbols: List all symbols in a file (requires file)
- workspace_symbols: Search for symbols across the workspace (requires query)
- incoming_calls: Find all callers of a function (requires file, line, symbol)
- outgoing_calls: Find all functions called by a function (requires file, line, symbol)
- rename: Rename a symbol across the codebase (requires file, line, symbol, new_name)
- code_actions: Get available code fixes/refactors at a location (requires file, line)
- status: Show which LSP servers are running
- reload: Restart all LSP servers`;

export function createLspTool(
	manager: LspClientManager,
	cwd: string,
): ToolDefinition<typeof lspSchema> {
	return {
		name: "lsp",
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
		await manager.shutdown();
		return "All LSP servers have been shut down. They will restart on next use.";
	}

	if (action === "workspace_symbols") {
		if (!input.query) return "Error: query is required for workspace_symbols";
		if (!input.file)
			return "Error: file is required for workspace_symbols (to determine which LSP server to use)";
		const client = await manager.getClientForFile(input.file, signal);
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
	if (!input.file) return `Error: file is required for ${action}`;
	const filePath = resolve(cwd, input.file);

	const client = await manager.getClientForFile(input.file, signal);
	if (!client) return `No LSP server available for ${input.file}`;

	// Sync the file before making requests
	await manager.syncFile(client, filePath);

	const uri = fileToUri(filePath);

	switch (action) {
		case "diagnostics": {
			// Wait briefly for diagnostics to arrive after sync
			await new Promise((r) => setTimeout(r, 500));
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
			if (!input.line) return "Error: line is required for hover";
			const pos = resolveSymbolPosition(
				filePath,
				input.line,
				input.symbol,
			);
			const hover = (await manager.sendRequest(
				client,
				"textDocument/hover",
				{ textDocument: { uri }, position: pos },
				signal,
			)) as Hover | null;

			return formatHover(hover);
		}

		case "definition":
		case "type_definition":
		case "implementation": {
			if (!input.line) return `Error: line is required for ${action}`;
			const pos = resolveSymbolPosition(
				filePath,
				input.line,
				input.symbol,
			);

			const methodMap = {
				definition: "textDocument/definition",
				type_definition: "textDocument/typeDefinition",
				implementation: "textDocument/implementation",
			};

			const result = (await manager.sendRequest(
				client,
				methodMap[action],
				{ textDocument: { uri }, position: pos },
				signal,
			)) as Location | Location[] | LocationLink[] | null;

			if (!result) return "No results found.";
			const locations = Array.isArray(result) ? result : [result];
			if (locations.length === 0) return "No results found.";

			// Show context for up to 5 results
			if (locations.length <= 5) {
				return locations
					.map((loc) => formatLocationWithContext(loc, cwd))
					.join("\n\n");
			}
			return formatLocations(locations, cwd);
		}

		case "references": {
			if (!input.line) return "Error: line is required for references";
			const pos = resolveSymbolPosition(
				filePath,
				input.line,
				input.symbol,
			);

			const refs = (await manager.sendRequest(
				client,
				"textDocument/references",
				{
					textDocument: { uri },
					position: pos,
					context: { includeDeclaration: true },
				},
				signal,
			)) as Location[] | null;

			return formatLocations(refs ?? [], cwd);
		}

		case "incoming_calls":
		case "outgoing_calls": {
			if (!input.line) return `Error: line is required for ${action}`;
			const pos = resolveSymbolPosition(
				filePath,
				input.line,
				input.symbol,
			);

			// First, prepare call hierarchy
			const items = (await manager.sendRequest(
				client,
				"textDocument/prepareCallHierarchy",
				{ textDocument: { uri }, position: pos },
				signal,
			)) as CallHierarchyItem[] | null;

			if (!items || items.length === 0)
				return "Could not resolve call hierarchy at this location.";

			const item = items[0];

			if (action === "incoming_calls") {
				const calls = (await manager.sendRequest(
					client,
					"callHierarchy/incomingCalls",
					{ item },
					signal,
				)) as CallHierarchyIncomingCall[] | null;

				return `Incoming calls to ${item.name}:\n${formatCallHierarchyIncoming(calls ?? [], cwd)}`;
			} else {
				const calls = (await manager.sendRequest(
					client,
					"callHierarchy/outgoingCalls",
					{ item },
					signal,
				)) as CallHierarchyOutgoingCall[] | null;

				return `Outgoing calls from ${item.name}:\n${formatCallHierarchyOutgoing(calls ?? [], cwd)}`;
			}
		}

		case "rename": {
			if (!input.line) return "Error: line is required for rename";
			if (!input.new_name) return "Error: new_name is required for rename";
			const pos = resolveSymbolPosition(
				filePath,
				input.line,
				input.symbol,
			);

			const edit = (await manager.sendRequest(
				client,
				"textDocument/rename",
				{
					textDocument: { uri },
					position: pos,
					newName: input.new_name,
				},
				signal,
			)) as WorkspaceEdit | null;

			if (!edit) return "Rename not supported at this location.";

			// Count affected files
			let fileCount = 0;
			if (edit.changes) {
				fileCount = Object.keys(edit.changes).length;
			} else if (edit.documentChanges) {
				fileCount = edit.documentChanges.length;
			}

			return `Rename would affect ${fileCount} file(s). Note: The rename edit was computed but not applied. Use the edit tool to apply changes manually.`;
		}

		case "code_actions": {
			if (!input.line) return "Error: line is required for code_actions";
			const pos = resolveSymbolPosition(
				filePath,
				input.line,
				input.symbol,
			);

			// Get diagnostics at this line
			const fileDiags = manager.getDiagnostics(client, filePath);
			const lineDiags: Diagnostic[] = [];
			for (const diags of fileDiags.values()) {
				for (const d of diags) {
					if (d.range.start.line === pos.line) {
						lineDiags.push(d);
					}
				}
			}

			const actions = (await manager.sendRequest(
				client,
				"textDocument/codeAction",
				{
					textDocument: { uri },
					range: { start: pos, end: pos },
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
