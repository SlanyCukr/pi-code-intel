import { describe, it, expect } from "vitest";

import {
	aggregateMetrics,
	extractMetrics,
	isGrepLikeBashCommand,
} from "../../src/analysis/metrics.js";
import type {
	AnalysisEvent,
	ParsedSession,
	SessionHeader,
} from "../../src/analysis/types.js";

const HEADER: SessionHeader = {
	type: "session",
	version: 3,
	id: "s-1",
	cwd: "/proj",
	timestamp: "2026-05-08T10:00:00.000Z",
};

/**
 * Helper to build a ParsedSession from a flat event array.
 * Sets `totalEntries` to events.length so tests don't have to manage it.
 */
function makeSession(
	events: AnalysisEvent[],
	overrides: Partial<ParsedSession> = {},
): ParsedSession {
	return {
		header: HEADER,
		events,
		filePath: "/tmp/s.jsonl",
		totalEntries: events.length,
		malformedLines: 0,
		...overrides,
	};
}

function toolCall(
	name: string,
	args: Record<string, unknown> = {},
	id: string = "ec",
	ts = "2026-05-08T10:00:01.000Z",
): AnalysisEvent {
	return {
		kind: "tool_call",
		entryId: id,
		lineNumber: 2,
		timestamp: ts,
		toolCallId: `tc-${id}`,
		name,
		arguments: args,
	};
}

function toolResult(
	toolName: string,
	isError: boolean,
	id: string = "er",
	ts = "2026-05-08T10:00:02.000Z",
): AnalysisEvent {
	return {
		kind: "tool_result",
		entryId: id,
		lineNumber: 3,
		timestamp: ts,
		toolCallId: `tc-${id}`,
		toolName,
		isError,
		contentText: isError ? "error msg" : "ok",
	};
}

describe("extractMetrics", () => {
	it("returns zero counts for an empty session", () => {
		const m = extractMetrics(makeSession([]));
		expect(m).toMatchObject({
			sessionId: "s-1",
			cwd: "/proj",
			totalEvents: 0,
			toolCallCount: 0,
			toolResultCount: 0,
			toolErrorCount: 0,
			toolCallsByName: {},
			toolErrorsByName: {},
		});
	});

	it("tabulates tool calls and errors by name", () => {
		const m = extractMetrics(
			makeSession([
				toolCall("read"),
				toolCall("read"),
				toolCall("edit"),
				toolResult("read", false),
				toolResult("read", false),
				toolResult("edit", true),
				toolResult("edit", true),
			]),
		);
		expect(m.toolCallCount).toBe(3);
		expect(m.toolResultCount).toBe(4);
		expect(m.toolErrorCount).toBe(2);
		expect(m.toolCallsByName).toEqual({ read: 2, edit: 1 });
		expect(m.toolErrorsByName).toEqual({ edit: 2 });
	});

	it("counts user_message, assistant_text, compaction, branch_summary separately", () => {
		const events: AnalysisEvent[] = [
			{
				kind: "user_message",
				entryId: "u",
				lineNumber: 2,
				timestamp: "t",
				text: "go",
			},
			{
				kind: "assistant_text",
				entryId: "a",
				lineNumber: 3,
				timestamp: "t",
				text: "ok",
			},
			{
				kind: "compaction",
				entryId: "c",
				lineNumber: 4,
				timestamp: "t",
				tokensBefore: 1000,
			},
			{
				kind: "branch_summary",
				entryId: "b",
				lineNumber: 5,
				timestamp: "t",
				fromId: "x",
			},
		];
		const m = extractMetrics(makeSession(events));
		expect(m).toMatchObject({
			userMessageCount: 1,
			assistantTextCount: 1,
			compactionCount: 1,
			branchSummaryCount: 1,
			toolCallCount: 0,
		});
	});

	it("computes durationMs from header to last timestamped event", () => {
		const m = extractMetrics(
			makeSession([
				toolCall("read", {}, "1", "2026-05-08T10:00:30.000Z"),
				toolResult("read", false, "2", "2026-05-08T10:01:30.000Z"),
			]),
		);
		expect(m.durationMs).toBe(90_000);
	});

	it("returns null durationMs when no events have parseable timestamps", () => {
		const m = extractMetrics(
			makeSession([toolCall("read", {}, "1", "not-a-date")]),
		);
		expect(m.durationMs).toBeNull();
	});

	it("returns null durationMs when the header timestamp is unparseable", () => {
		const broken = makeSession([toolCall("read")], {
			header: { ...HEADER, timestamp: "garbage" },
		});
		const m = extractMetrics(broken);
		expect(m.durationMs).toBeNull();
	});
});

describe("aggregateMetrics", () => {
	it("sums tool calls across sessions and ranks by frequency", () => {
		const sessions = [
			makeSession([toolCall("read"), toolCall("read"), toolCall("edit")]),
			makeSession([toolCall("read"), toolCall("lsp"), toolCall("lsp")]),
		];
		const perSession = sessions.map(extractMetrics);
		const events = sessions.map((s) => s.events);
		const agg = aggregateMetrics(perSession, events);

		expect(agg.sessionCount).toBe(2);
		expect(agg.totalToolCalls).toBe(6);
		expect(agg.totalReads).toBe(3);
		expect(agg.totalEdits).toBe(1);
		expect(agg.totalLspCalls).toBe(2);
		expect(agg.topToolsByFrequency).toEqual([
			{ name: "read", count: 3 },
			{ name: "lsp", count: 2 },
			{ name: "edit", count: 1 },
		]);
	});

	it("computes read:lsp ratio and returns null when lsp count is zero", () => {
		const sNoLsp = makeSession([toolCall("read"), toolCall("read")]);
		const aggNo = aggregateMetrics([extractMetrics(sNoLsp)], [sNoLsp.events]);
		expect(aggNo.readLspRatio).toBeNull();

		const sWithLsp = makeSession([
			toolCall("read"),
			toolCall("read"),
			toolCall("lsp"),
		]);
		const aggYes = aggregateMetrics(
			[extractMetrics(sWithLsp)],
			[sWithLsp.events],
		);
		expect(aggYes.readLspRatio).toBeCloseTo(2.0, 5);
	});

	it("computes editFailureRate from per-session error counts", () => {
		const s = makeSession([
			toolCall("edit"),
			toolCall("edit"),
			toolCall("edit"),
			toolCall("edit"),
			toolResult("edit", true),
			toolResult("edit", false),
			toolResult("edit", false),
			toolResult("edit", false),
		]);
		const agg = aggregateMetrics([extractMetrics(s)], [s.events]);
		expect(agg.editFailureRate).toBeCloseTo(0.25, 5);
	});

	it("returns null editFailureRate when no edit calls exist", () => {
		const s = makeSession([toolCall("read")]);
		const agg = aggregateMetrics([extractMetrics(s)], [s.events]);
		expect(agg.editFailureRate).toBeNull();
	});

	it("classifies grep-like bash commands and computes grep:lsp ratio", () => {
		const s = makeSession([
			toolCall("bash", { command: "rg foo src/" }),
			toolCall("bash", { command: "grep -n bar src/foo.ts" }),
			toolCall("bash", { command: "git log --oneline -10" }), // not grep-like
			toolCall("bash", { command: "git log | grep fix" }), // pipeline FROM unrelated cmd: NOT counted
			toolCall("lsp", { action: "definition" }),
		]);
		const agg = aggregateMetrics([extractMetrics(s)], [s.events]);
		expect(agg.totalBashCalls).toBe(4);
		expect(agg.totalGrepCalls).toBe(2);
		expect(agg.grepLspRatio).toBeCloseTo(2.0, 5);
	});

	it("avgReadsPerSession and avgToolCallsPerSession use sessionCount as divisor", () => {
		const s1 = makeSession([toolCall("read"), toolCall("read")]);
		const s2 = makeSession([toolCall("read"), toolCall("edit")]);
		const agg = aggregateMetrics(
			[extractMetrics(s1), extractMetrics(s2)],
			[s1.events, s2.events],
		);
		expect(agg.avgReadsPerSession).toBeCloseTo(1.5, 5);
		expect(agg.avgToolCallsPerSession).toBeCloseTo(2.0, 5);
	});

	it("does not divide by zero when given an empty session list", () => {
		const agg = aggregateMetrics([], []);
		// avg* fall back to division by 1 (the `|| 1` guard) — they're
		// effectively zero / one. Critically: no Infinity, no NaN.
		expect(agg.avgReadsPerSession).toBe(0);
		expect(agg.avgToolCallsPerSession).toBe(0);
		expect(agg.readLspRatio).toBeNull();
		expect(agg.grepLspRatio).toBeNull();
		expect(agg.editFailureRate).toBeNull();
	});
});

describe("isGrepLikeBashCommand", () => {
	const positives = [
		"rg foo",
		"  grep -rn bar src/",
		"egrep -i pattern file.ts",
		"fgrep needle file",
		"ag --hidden xyz",
		"ack -l TODO",
		"find . -name '*.ts'",
		"FOO=1 BAR=2 rg foo", // env-prefixed
	];
	for (const cmd of positives) {
		it(`flags as grep-like: ${cmd}`, () => {
			expect(isGrepLikeBashCommand(cmd)).toBe(true);
		});
	}

	const negatives = [
		"git status",
		"npm run build",
		"node script.ts",
		"cat file | grep foo", // pipeline starts with cat — body grep, but first tok is cat
		"ls -la",
		"find . -type f", // find without -name (e.g. listing files): not a name search
		"",
		"   ",
	];
	for (const cmd of negatives) {
		it(`does not flag: ${JSON.stringify(cmd)}`, () => {
			expect(isGrepLikeBashCommand(cmd)).toBe(false);
		});
	}
});
