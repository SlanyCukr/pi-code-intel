import type { AnalysisEvent, ParsedSession } from "./types.js";

/**
 * Aggregate metrics over one or more sessions.
 *
 * Two flavors:
 * - `SessionMetrics`: the per-session breakdown (one struct per file).
 * - `AggregatedMetrics`: sums/ratios across N sessions (used by the
 *   summary section of the report).
 *
 * Ratios use a small denominator guard: if the divisor is 0 we report
 * `null` rather than `Infinity` or `NaN`, so the markdown report can
 * print a sensible "n/a" instead of garbage.
 */
export interface SessionMetrics {
	sessionId: string;
	filePath: string;
	cwd: string;
	startedAt: string; // ISO from header
	/** Wall-clock duration in milliseconds, or null if no events with timestamps. */
	durationMs: number | null;
	totalEvents: number;
	totalEntries: number;
	malformedLines: number;
	userMessageCount: number;
	assistantTextCount: number;
	toolCallCount: number;
	toolResultCount: number;
	toolErrorCount: number;
	compactionCount: number;
	branchSummaryCount: number;
	/** Tool name → count of tool_call events. */
	toolCallsByName: Record<string, number>;
	/** Tool name → count of tool_result events with isError: true. */
	toolErrorsByName: Record<string, number>;
	/**
	 * Mirrors `ParsedSession.isSubAgent`. Lifted to the metrics layer so
	 * downstream filters (main-only aggregation, renderer disclosures) can
	 * partition without round-tripping through the parsed-sessions array.
	 */
	isSubAgent: boolean;
}

export interface AggregatedMetrics {
	sessionCount: number;
	totalToolCalls: number;
	totalToolErrors: number;
	totalReads: number;
	totalEdits: number;
	totalLspCalls: number;
	totalGrepCalls: number;
	totalBashCalls: number;
	/**
	 * `read:lsp` ratio. `null` when the lsp call count is 0 (avoid div/0
	 * and report n/a in the renderer).
	 */
	readLspRatio: number | null;
	/**
	 * `grep:lsp` ratio (where "grep" = bash invocations whose command
	 * looks like a grep/rg/find with text-search intent). Same null
	 * semantics as readLspRatio.
	 */
	grepLspRatio: number | null;
	/** Edit failures / total edits. `null` if no edits. */
	editFailureRate: number | null;
	avgReadsPerSession: number;
	avgToolCallsPerSession: number;
	/** Tool name → total count across all sessions, sorted descending. */
	topToolsByFrequency: Array<{ name: string; count: number }>;
}

/**
 * Compute per-session metrics from a parsed session.
 */
export function extractMetrics(session: ParsedSession): SessionMetrics {
	const toolCallsByName: Record<string, number> = {};
	const toolErrorsByName: Record<string, number> = {};
	let userMessageCount = 0;
	let assistantTextCount = 0;
	let toolCallCount = 0;
	let toolResultCount = 0;
	let toolErrorCount = 0;
	let compactionCount = 0;
	let branchSummaryCount = 0;

	for (const ev of session.events) {
		switch (ev.kind) {
			case "user_message":
				userMessageCount++;
				break;
			case "assistant_text":
				assistantTextCount++;
				break;
			case "tool_call":
				toolCallCount++;
				toolCallsByName[ev.name] = (toolCallsByName[ev.name] ?? 0) + 1;
				break;
			case "tool_result":
				toolResultCount++;
				if (ev.isError) {
					toolErrorCount++;
					toolErrorsByName[ev.toolName] =
						(toolErrorsByName[ev.toolName] ?? 0) + 1;
				}
				break;
			case "compaction":
				compactionCount++;
				break;
			case "branch_summary":
				branchSummaryCount++;
				break;
		}
	}

	return {
		sessionId: session.header.id,
		filePath: session.filePath,
		cwd: session.header.cwd,
		startedAt: session.header.timestamp,
		durationMs: computeDurationMs(session.events, session.header.timestamp),
		totalEvents: session.events.length,
		totalEntries: session.totalEntries,
		malformedLines: session.malformedLines,
		userMessageCount,
		assistantTextCount,
		toolCallCount,
		toolResultCount,
		toolErrorCount,
		compactionCount,
		branchSummaryCount,
		toolCallsByName,
		toolErrorsByName,
		isSubAgent: session.isSubAgent,
	};
}

/**
 * Aggregate metrics across many sessions for the summary + efficiency
 * report sections.
 *
 * Bash-call classification: a `bash` tool call is counted as a "grep
 * call" when its `command` argument matches `isGrepLikeBashCommand`
 * (rg/grep/find/ag invocations, including pipelines that start with
 * one). This is approximate but sufficient for ratio-level signal.
 */
export function aggregateMetrics(
	perSession: SessionMetrics[],
	rawEvents: AnalysisEvent[][],
): AggregatedMetrics {
	const totals: Record<string, number> = {};
	let totalToolCalls = 0;
	let totalToolErrors = 0;
	let totalGrepCalls = 0;
	let totalBashCalls = 0;
	let totalEditCalls = 0;
	let totalEditErrors = 0;

	for (const m of perSession) {
		totalToolCalls += m.toolCallCount;
		totalToolErrors += m.toolErrorCount;
		for (const [name, n] of Object.entries(m.toolCallsByName)) {
			totals[name] = (totals[name] ?? 0) + n;
		}
		totalEditCalls += m.toolCallsByName["edit"] ?? 0;
		totalEditErrors += m.toolErrorsByName["edit"] ?? 0;
	}

	for (const events of rawEvents) {
		for (const ev of events) {
			if (ev.kind !== "tool_call") continue;
			if (ev.name !== "bash") continue;
			totalBashCalls++;
			const cmd = typeof ev.arguments?.command === "string"
				? ev.arguments.command
				: "";
			if (isGrepLikeBashCommand(cmd)) totalGrepCalls++;
		}
	}

	const totalReads = totals["read"] ?? 0;
	const totalLspCalls = totals["lsp"] ?? 0;
	const totalEdits = totalEditCalls;

	const readLspRatio = totalLspCalls > 0 ? totalReads / totalLspCalls : null;
	const grepLspRatio = totalLspCalls > 0 ? totalGrepCalls / totalLspCalls : null;
	const editFailureRate = totalEdits > 0 ? totalEditErrors / totalEdits : null;

	const sessionCount = perSession.length || 1; // guard against div/0 in averages of empty input

	const topToolsByFrequency = Object.entries(totals)
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count);

	return {
		sessionCount: perSession.length,
		totalToolCalls,
		totalToolErrors,
		totalReads,
		totalEdits,
		totalLspCalls,
		totalGrepCalls,
		totalBashCalls,
		readLspRatio,
		grepLspRatio,
		editFailureRate,
		avgReadsPerSession: totalReads / sessionCount,
		avgToolCallsPerSession: totalToolCalls / sessionCount,
		topToolsByFrequency,
	};
}

/**
 * True when a bash command looks like a text-search invocation that an
 * LSP query would have answered more precisely.
 *
 * Matches: rg, grep, ack, ag, fgrep, egrep, find ... -name, ls | grep.
 * Tolerates leading whitespace, common flags, and pipelines that START
 * with a search tool. Does NOT flag pipelines where grep filters the
 * output of an unrelated command (e.g. `git log | grep fix`) — those are
 * usually not "find a symbol" queries.
 *
 * Conservative on purpose: false negatives are fine (the rule errs
 * toward not flagging). False positives are not — they would dilute
 * the grep:lsp ratio with non-search bash usage.
 */
export function isGrepLikeBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	// Strip leading env assignments like `FOO=bar rg ...` for robustness.
	const stripped = trimmed.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
	// First token of the (possibly piped) command.
	const firstTok = stripped.split(/[|;&]/)[0].trim().split(/\s+/)[0] ?? "";
	const SEARCH_BINARIES = new Set([
		"grep",
		"rg",
		"ack",
		"ag",
		"fgrep",
		"egrep",
	]);
	if (SEARCH_BINARIES.has(firstTok)) return true;
	// `find PATH ... -name ...` is also a search-by-name call.
	if (firstTok === "find" && /\s-name\b/.test(stripped)) return true;
	return false;
}

/**
 * Compute wall-clock duration from session start to the timestamp of
 * the last event. Returns null if no events have parseable timestamps.
 */
function computeDurationMs(
	events: AnalysisEvent[],
	startedAtIso: string,
): number | null {
	const start = Date.parse(startedAtIso);
	if (!Number.isFinite(start)) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		const t = Date.parse(events[i].timestamp);
		if (Number.isFinite(t)) return Math.max(0, t - start);
	}
	return null;
}
