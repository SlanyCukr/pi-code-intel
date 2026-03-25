// LSP Protocol Types

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	source?: string;
	message: string;
	relatedInformation?: DiagnosticRelatedInformation[];
}

export interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

export enum DiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	location: Location;
	containerName?: string;
}

export enum SymbolKind {
	File = 1,
	Module = 2,
	Namespace = 3,
	Package = 4,
	Class = 5,
	Method = 6,
	Property = 7,
	Field = 8,
	Constructor = 9,
	Enum = 10,
	Interface = 11,
	Function = 12,
	Variable = 13,
	Constant = 14,
	String = 15,
	Number = 16,
	Boolean = 17,
	Array = 18,
	Object = 19,
	Key = 20,
	Null = 21,
	EnumMember = 22,
	Struct = 23,
	Event = 24,
	Operator = 25,
	TypeParameter = 26,
}

export interface Hover {
	contents: MarkupContent | string;
	range?: Range;
}

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

interface TextEdit {
	range: Range;
	newText: string;
}

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}

interface TextDocumentEdit {
	textDocument: { uri: string; version: number | null };
	edits: TextEdit[];
}

interface CreateFile {
	kind: "create";
	uri: string;
}

interface RenameFile {
	kind: "rename";
	oldUri: string;
	newUri: string;
}

interface DeleteFile {
	kind: "delete";
	uri: string;
}

export interface CodeAction {
	title: string;
	kind?: string;
	diagnostics?: Diagnostic[];
	edit?: WorkspaceEdit;
	command?: Command;
	isPreferred?: boolean;
}

interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface CallHierarchyItem {
	name: string;
	kind: SymbolKind;
	uri: string;
	range: Range;
	selectionRange: Range;
	detail?: string;
}

export interface CallHierarchyIncomingCall {
	from: CallHierarchyItem;
	fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
	to: CallHierarchyItem;
	fromRanges: Range[];
}

// Server Configuration

export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	rootMarkers: string[];
	settings?: Record<string, unknown>;
	initOptions?: Record<string, unknown>;
	isLinter?: boolean;
	env?: Record<string, string>;
}

