import type {
	AnalysisEvent,
	ParsedSession,
	SessionHeader,
} from "../../../src/analysis/types.js";

/**
 * Shared fixture builders for pattern-rule tests. Kept in one place so
 * each rule test can focus on its own scenarios rather than fixture
 * boilerplate.
 */

const HEADER: SessionHeader = {
	type: "session",
	version: 3,
	id: "session-test",
	cwd: "/proj",
	timestamp: "2026-05-08T10:00:00.000Z",
};

let lineCounter = 2;

export function resetLineCounter(): void {
	lineCounter = 2;
}

export function makeSession(events: AnalysisEvent[]): ParsedSession {
	return {
		header: HEADER,
		events,
		filePath: "/tmp/s.jsonl",
		totalEntries: events.length,
		malformedLines: 0,
	};
}

/** Auto-incrementing line number so events appear in file order. */
function nextLine(): number {
	return lineCounter++;
}

export function tcRead(path: string, opts: { limit?: number; offset?: number } = {}): AnalysisEvent {
	const ln = nextLine();
	const args: Record<string, unknown> = { path };
	if (opts.limit !== undefined) args.limit = opts.limit;
	if (opts.offset !== undefined) args.offset = opts.offset;
	return {
		kind: "tool_call",
		entryId: `e${ln}`,
		lineNumber: ln,
		timestamp: "t",
		toolCallId: `tc${ln}`,
		name: "read",
		arguments: args,
	};
}

export function tcEdit(path: string, toolCallId?: string): AnalysisEvent {
	const ln = nextLine();
	return {
		kind: "tool_call",
		entryId: `e${ln}`,
		lineNumber: ln,
		timestamp: "t",
		toolCallId: toolCallId ?? `tc${ln}`,
		name: "edit",
		arguments: { path },
	};
}

export function tcWrite(path: string): AnalysisEvent {
	const ln = nextLine();
	return {
		kind: "tool_call",
		entryId: `e${ln}`,
		lineNumber: ln,
		timestamp: "t",
		toolCallId: `tc${ln}`,
		name: "write",
		arguments: { path },
	};
}

export function tcBash(command: string): AnalysisEvent {
	const ln = nextLine();
	return {
		kind: "tool_call",
		entryId: `e${ln}`,
		lineNumber: ln,
		timestamp: "t",
		toolCallId: `tc${ln}`,
		name: "bash",
		arguments: { command },
	};
}

export function tcLsp(action: string, args: Record<string, unknown> = {}): AnalysisEvent {
	const ln = nextLine();
	return {
		kind: "tool_call",
		entryId: `e${ln}`,
		lineNumber: ln,
		timestamp: "t",
		toolCallId: `tc${ln}`,
		name: "lsp",
		arguments: { action, ...args },
	};
}

export function trResult(
	toolCallId: string,
	toolName: string,
	isError: boolean,
): AnalysisEvent {
	const ln = nextLine();
	return {
		kind: "tool_result",
		entryId: `e${ln}`,
		lineNumber: ln,
		timestamp: "t",
		toolCallId,
		toolName,
		isError,
		contentText: isError ? "error" : "ok",
	};
}
