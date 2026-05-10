import { describe, it, expect } from "vitest";

import {
	aggregateMetrics,
	extractMetrics,
	type SessionMetrics,
} from "../../src/analysis/metrics.js";
import type { OutcomeData } from "../../src/analysis/outcomes.js";
import { renderMarkdown } from "../../src/analysis/report.js";
import type {
	AntiPatternHit,
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

function makeSession(events: AnalysisEvent[], opts: { isSubAgent?: boolean } = {}): ParsedSession {
	return {
		header: HEADER,
		events,
		filePath: "/tmp/s.jsonl",
		totalEntries: events.length,
		malformedLines: 0,
		isSubAgent: opts.isSubAgent ?? false,
	};
}

function tc(name: string, args: Record<string, unknown> = {}, line = 2): AnalysisEvent {
	return {
		kind: "tool_call",
		entryId: `e${line}`,
		lineNumber: line,
		timestamp: "2026-05-08T10:00:01.000Z",
		toolCallId: `tc${line}`,
		name,
		arguments: args,
	};
}

const FIXED_DATE = new Date("2026-05-08T15:30:45.000Z");

describe("renderMarkdown", () => {
	it("renders a stable header with the date and ISO timestamp", () => {
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [],
			aggregated: aggregateMetrics([], []),
			hitsBySession: new Map(),
		});
		expect(md).toContain("# Pi session analysis — 2026-05-08");
		expect(md).toContain("Generated: 2026-05-08T15:30:45.000Z");
	});

	it("renders all five section headings even when sections are empty", () => {
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [],
			aggregated: aggregateMetrics([], []),
			hitsBySession: new Map(),
		});
		expect(md).toMatch(/^## 1\. Summary$/m);
		expect(md).toMatch(/^## 2\. Efficiency$/m);
		expect(md).toMatch(/^## 3\. Anti-patterns$/m);
		expect(md).toMatch(/^## 4\. Outcomes$/m);
		expect(md).toMatch(/^## 5\. Propose$/m);
	});

	it("renders `(no sessions analyzed)` in the summary when given empty input", () => {
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [],
			aggregated: aggregateMetrics([], []),
			hitsBySession: new Map(),
		});
		expect(md).toContain("(no sessions analyzed)");
	});

	it("renders summary stats and top-tools table when sessions present", () => {
		const session = makeSession([tc("read"), tc("read"), tc("lsp")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
		});
		expect(md).toContain("Sessions analyzed: **1**");
		expect(md).toContain("Total tool calls: **3**");
		expect(md).toContain("| `read` | 2 |");
		expect(md).toContain("| `lsp` | 1 |");
	});

	it("renders read:lsp ratio and a hint when ratio > 1.5", () => {
		// 4 reads / 1 lsp = 4.0 -> should render the hint
		const session = makeSession([tc("read"), tc("read"), tc("read"), tc("read"), tc("lsp")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
		});
		expect(md).toContain("| **read : lsp** | 4.00 |");
		expect(md).toContain("over-reading");
	});

	it("renders the efficiency table as two columns when aggregatedMain is supplied", () => {
		// Two sessions, one main (4 reads / 1 lsp = 4.0) and one sub-agent
		// (8 reads / 0 lsp = null). All-sessions ratio is also 4.0 here
		// because lsp counts are equal, but the column structure must
		// render whenever aggregatedMain is present.
		const main = makeSession([tc("read"), tc("read"), tc("read"), tc("read"), tc("lsp")]);
		const sub = makeSession([tc("read"), tc("read"), tc("read"), tc("read"), tc("read"), tc("read"), tc("read"), tc("read")], { isSubAgent: true });
		const mMain = extractMetrics(main);
		const mSub = extractMetrics(sub);
		const all = aggregateMetrics([mMain, mSub], [main.events, sub.events]);
		const mainOnly = aggregateMetrics([mMain], [main.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [mMain, mSub],
			aggregated: all,
			aggregatedMain: mainOnly,
			hitsBySession: new Map(),
		});
		expect(md).toContain("| Metric | Main sessions | All sessions |");
		expect(md).toContain("main-session read:lsp"); // hint reflects main, not all
	});

	it("falls back to a single-column efficiency table when no sub-agents present", () => {
		const main = makeSession([tc("read"), tc("read"), tc("lsp")]);
		const m = extractMetrics(main);
		const agg = aggregateMetrics([m], [main.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
			// aggregatedMain intentionally omitted
		});
		expect(md).toContain("| Metric | Value |");
		expect(md).not.toContain("Main sessions");
	});

	it("renders n/a for null ratios", () => {
		const session = makeSession([tc("read"), tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
		});
		expect(md).toContain("| **read : lsp** | n/a |");
		expect(md).toContain("| **edit failure rate** | n/a |");
	});

	it("renders `(no findings)` for anti-patterns when no hits exist", () => {
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [],
			aggregated: aggregateMetrics([], []),
			hitsBySession: new Map(),
		});
		// The anti-patterns section should explicitly say (no findings),
		// not just be empty.
		const antiPatternSection = md.split("## 3. Anti-patterns")[1].split("## 4.")[0];
		expect(antiPatternSection).toContain("(no findings)");
	});

	it("renders rule summary table and per-rule sample list", () => {
		const hits: AntiPatternHit[] = [
			{
				ruleId: "read-twice-no-edit",
				sessionId: "s-1",
				filePath: "/tmp/s.jsonl",
				lineRange: [10, 12],
				message: "read foo.ts again at line 12",
			},
			{
				ruleId: "read-twice-no-edit",
				sessionId: "s-1",
				filePath: "/tmp/s.jsonl",
				lineRange: [20, 22],
				message: "read bar.ts again at line 22",
			},
			{
				ruleId: "grep-for-symbol",
				sessionId: "s-1",
				filePath: "/tmp/s.jsonl",
				lineRange: [5, 5],
				message: "grep for `myFunc`",
			},
		];
		const session = makeSession([tc("read"), tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map([["s-1", hits]]),
		});
		// Summary table
		expect(md).toContain("| `read-twice-no-edit` | 2 |");
		expect(md).toContain("| `grep-for-symbol` | 1 |");
		// Per-rule sample
		expect(md).toContain("read foo.ts again at line 12");
		expect(md).toContain("grep for `myFunc`");
	});

	it("truncates per-rule sample to 10 hits and notes the omission", () => {
		const hits: AntiPatternHit[] = Array.from({ length: 25 }, (_, i) => ({
			ruleId: "read-twice-no-edit",
			sessionId: "s-1",
			filePath: "/tmp/s.jsonl",
			lineRange: [i * 10, i * 10 + 1],
			message: `hit number ${i + 1}`,
		}));
		const session = makeSession([tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map([["s-1", hits]]),
		});
		expect(md).toContain("hit number 1");
		expect(md).toContain("hit number 10");
		expect(md).not.toContain("hit number 11"); // truncated
		expect(md).toContain("...15 more hits omitted");
	});

	it("orders rules deterministically (alphabetical by ruleId)", () => {
		const hits: AntiPatternHit[] = [
			{
				ruleId: "z-rule",
				sessionId: "s-1",
				filePath: "/tmp/s.jsonl",
				lineRange: [1, 1],
				message: "z",
			},
			{
				ruleId: "a-rule",
				sessionId: "s-1",
				filePath: "/tmp/s.jsonl",
				lineRange: [2, 2],
				message: "a",
			},
		];
		const session = makeSession([tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map([["s-1", hits]]),
		});
		const aPos = md.indexOf("`a-rule`");
		const zPos = md.indexOf("`z-rule`");
		expect(aPos).toBeGreaterThan(0);
		expect(zPos).toBeGreaterThan(aPos);
	});

	it("renders an outcomes table when outcomesBySession is provided", () => {
		const session = makeSession([tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const outcome: OutcomeData = {
			sessionId: "s-1",
			cwd: "/proj",
			windowStart: "2026-05-08T10:00:00.000Z",
			windowEnd: "2026-05-08T10:05:00.000Z",
			gitUnavailable: false,
			commitsInWindow: [
				{ sha: "abc12345".padEnd(40, "0"), subject: "Add feature X", timestamp: "2026-05-08T10:01:00+00:00" },
			],
			revertedShas: [],
			lastToolWasError: false,
		};
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
			outcomesBySession: new Map([["s-1", outcome]]),
		});
		expect(md).toContain("| Session | Commits | Reverted later | Last tool errored |");
		expect(md).toContain("`s-1`".slice(0, 4)); // truncated to 8 chars; check sha8 prefix
		expect(md).toContain("Add feature X");
	});

	it("flags reverted commits with a warning glyph", () => {
		const session = makeSession([tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const sha = "feedface".padEnd(40, "0");
		const outcome: OutcomeData = {
			sessionId: "s-1",
			cwd: "/proj",
			windowStart: "2026-05-08T10:00:00.000Z",
			windowEnd: "2026-05-08T10:05:00.000Z",
			gitUnavailable: false,
			commitsInWindow: [
				{ sha, subject: "Buggy thing", timestamp: "2026-05-08T10:01:00+00:00" },
			],
			revertedShas: [sha],
			lastToolWasError: false,
		};
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
			outcomesBySession: new Map([["s-1", outcome]]),
		});
		expect(md).toContain("⚠ 1"); // count of reverted in table
		expect(md).toContain("⚠ reverted later"); // per-commit detail
	});

	it("renders 'git n/a' for sessions where git was unavailable", () => {
		const session = makeSession([tc("read")]);
		const m = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const outcome: OutcomeData = {
			sessionId: "s-1",
			cwd: "/missing",
			windowStart: "2026-05-08T10:00:00.000Z",
			windowEnd: "2026-05-08T10:05:00.000Z",
			gitUnavailable: true,
			gitUnavailableReason: "cwd is not a git repository",
			commitsInWindow: [],
			revertedShas: [],
			lastToolWasError: null,
		};
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
			outcomesBySession: new Map([["s-1", outcome]]),
		});
		expect(md).toContain("git n/a");
		expect(md).toContain("git unavailable: cwd is not a git repository");
	});

	it("renders '(no findings)' for outcomes when outcomesBySession is omitted", () => {
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [],
			aggregated: aggregateMetrics([], []),
			hitsBySession: new Map(),
		});
		const section = md.split("## 4. Outcomes")[1].split("## 5.")[0];
		expect(section).toContain("(no findings)");
	});

	it("includes the malformed-line count in the summary when nonzero", () => {
		const session: ParsedSession = {
			header: HEADER,
			events: [],
			filePath: "/tmp/s.jsonl",
			totalEntries: 0,
			malformedLines: 3,
			isSubAgent: false,
		};
		const m: SessionMetrics = extractMetrics(session);
		const agg = aggregateMetrics([m], [session.events]);
		const md = renderMarkdown({
			generatedAt: FIXED_DATE,
			sessionMetrics: [m],
			aggregated: agg,
			hitsBySession: new Map(),
		});
		expect(md).toContain("Malformed JSONL lines skipped: **3**");
	});
});
