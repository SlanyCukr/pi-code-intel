import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildProposalPrompt,
	generateProposals,
	selectGrounding,
} from "../../src/analysis/propose.js";
import { aggregateMetrics } from "../../src/analysis/metrics.js";
import type {
	AnalysisEvent,
	AntiPatternHit,
	ParsedSession,
	SessionHeader,
} from "../../src/analysis/types.js";

// Mock createIsolatedSession (the SDK boundary). The shared
// runIsolatedTextCall helper lives in its own module so its abort and
// lifecycle logic continues to run end-to-end through these tests.
vi.mock("../../src/isolated-session.js", () => ({
	createIsolatedSession: vi.fn(),
}));

import { createIsolatedSession } from "../../src/isolated-session.js";
const mockCreateSession = vi.mocked(createIsolatedSession);

beforeEach(() => {
	vi.clearAllMocks();
});

const HEADER: SessionHeader = {
	type: "session",
	version: 3,
	id: "s-1",
	cwd: "/proj",
	timestamp: "2026-05-08T10:00:00.000Z",
};

function makeSession(events: AnalysisEvent[], header: SessionHeader = HEADER): ParsedSession {
	return {
		header,
		events,
		filePath: "/tmp/s.jsonl",
		totalEntries: events.length,
		malformedLines: 0,
		isSubAgent: false,
	};
}

function captureEvent(text: string, capturedAt = "2026-05-08T10:00:01.000Z"): AnalysisEvent {
	return {
		kind: "system_prompt_captured",
		entryId: "sp1",
		lineNumber: 2,
		timestamp: capturedAt,
		text,
		hash: "abc123def4567890",
		capturedAt,
		activeTools: ["read", "edit"],
	};
}

describe("selectGrounding", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-propose-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns kind=captured when at least one session has a system_prompt_captured event", () => {
		const session = makeSession([captureEvent("captured prompt text")]);
		const result = selectGrounding([session], "/does-not-exist");
		expect(result).toMatchObject({
			kind: "captured",
			text: "captured prompt text",
			sessionId: "s-1",
		});
	});

	it("picks the most-recent session when multiple have captures", () => {
		const older = makeSession(
			[captureEvent("older prompt", "2026-05-01T10:00:00.000Z")],
			{ ...HEADER, id: "older", timestamp: "2026-05-01T10:00:00.000Z" },
		);
		const newer = makeSession(
			[captureEvent("newer prompt", "2026-05-08T10:00:00.000Z")],
			{ ...HEADER, id: "newer", timestamp: "2026-05-08T10:00:00.000Z" },
		);
		const result = selectGrounding([older, newer], "/does-not-exist");
		expect(result).toMatchObject({ kind: "captured", text: "newer prompt", sessionId: "newer" });
	});

	it("falls back to source file when no session has captures", () => {
		const sourcePath = join(tmp, "system-prompt.ts");
		writeFileSync(sourcePath, "export const SYSTEM_PROMPT = 'be smart';\n", "utf-8");
		const session = makeSession([]); // no captures
		const result = selectGrounding([session], sourcePath);
		expect(result).toMatchObject({
			kind: "source-fallback",
			sourcePath,
		});
		expect(
			(result as { text: string }).text.includes("be smart"),
		).toBe(true);
	});

	it("returns kind=none when source path does not exist and no captures", () => {
		const session = makeSession([]);
		const result = selectGrounding([session], join(tmp, "nope.ts"));
		expect(result.kind).toBe("none");
		expect((result as { reason: string }).reason).toMatch(/source path/);
	});

	it("returns kind=none when source file exists but is empty", () => {
		const sourcePath = join(tmp, "empty.ts");
		writeFileSync(sourcePath, "  \n  \n", "utf-8");
		const result = selectGrounding([], sourcePath);
		expect(result.kind).toBe("none");
		expect((result as { reason: string }).reason).toMatch(/empty/);
	});
});

describe("buildProposalPrompt", () => {
	const aggregated = aggregateMetrics([], []);

	it("includes metrics section, hits section, system-prompt section, and task section", () => {
		const hits: AntiPatternHit[] = [
			{
				ruleId: "read-twice-no-edit",
				sessionId: "s-1",
				filePath: "/tmp/s.jsonl",
				lineRange: [10, 20],
				message: "read foo.ts twice",
			},
		];
		const prompt = buildProposalPrompt({
			aggregated,
			hits,
			grounding: { kind: "captured", sessionId: "abcd1234", capturedAt: "t", text: "PROMPT TEXT" },
		});
		expect(prompt).toContain("## Aggregated metrics");
		expect(prompt).toContain("## Top anti-pattern hits");
		expect(prompt).toContain("## System prompt being amended");
		expect(prompt).toContain("PROMPT TEXT");
		expect(prompt).toContain("## Your task");
		expect(prompt).toContain("read-twice-no-edit");
	});

	it("labels source-fallback grounding as forward-looking", () => {
		const prompt = buildProposalPrompt({
			aggregated,
			hits: [],
			grounding: { kind: "source-fallback", sourcePath: "/x.ts", text: "SRC" },
		});
		expect(prompt).toContain("forward-looking");
		expect(prompt).toContain("SRC");
	});

	it("renders kind=none with no prompt-text block", () => {
		const prompt = buildProposalPrompt({
			aggregated,
			hits: [],
			grounding: { kind: "none", reason: "no data" },
		});
		expect(prompt).toContain("grounding unavailable: no data");
		expect(prompt).not.toContain("```\n");
	});

	it("notes when there are zero anti-pattern hits", () => {
		const prompt = buildProposalPrompt({
			aggregated,
			hits: [],
			grounding: { kind: "captured", sessionId: "x", capturedAt: "t", text: "p" },
		});
		expect(prompt).toContain("(no anti-pattern hits across analyzed sessions)");
	});

	it("caps included hit detail at topK", () => {
		const hits: AntiPatternHit[] = Array.from({ length: 50 }, (_, i) => ({
			ruleId: `rule-${i % 3}`,
			sessionId: "s",
			filePath: "/x",
			lineRange: [i, i + 1],
			message: `hit ${i}`,
		}));
		const prompt = buildProposalPrompt({
			aggregated,
			hits,
			grounding: { kind: "none", reason: "test" },
			topK: 5,
		});
		// Count rendered "- hit N" lines.
		const matches = prompt.match(/^- hit \d+/gm) ?? [];
		expect(matches.length).toBeLessThanOrEqual(6); // small slack: rounded sample size per rule
	});
});

describe("generateProposals", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-propose-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns a `(skipped)` block when grounding is unavailable", async () => {
		const session = makeSession([]);
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: join(tmp, "missing.ts"),
			},
			{ cwd: tmp },
		);
		expect(result).toContain("## Proposed amendments");
		expect(result).toContain("(skipped:");
		expect(mockCreateSession).not.toHaveBeenCalled();
	});

	it("returns the model output appended with a captured-grounding footer", async () => {
		const fakeSession = {
			agent: { setSystemPrompt: vi.fn() },
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "## Proposed amendments\n\n- something" }],
				},
			],
			prompt: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(),
		};
		mockCreateSession.mockResolvedValueOnce({ session: fakeSession } as any);

		const session = makeSession([captureEvent("the captured prompt")]);
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: join(tmp, "anything.ts"),
			},
			{ cwd: tmp },
		);
		expect(result).toContain("## Proposed amendments");
		expect(result).toContain("- something");
		expect(result).toContain("Grounded in the system prompt captured");
		expect(fakeSession.agent.setSystemPrompt).toHaveBeenCalledWith("");
		expect(fakeSession.dispose).toHaveBeenCalled();
	});

	it("returns a forward-looking footer when using source fallback", async () => {
		const sourcePath = join(tmp, "system-prompt.ts");
		writeFileSync(sourcePath, "the source", "utf-8");
		const fakeSession = {
			agent: { setSystemPrompt: vi.fn() },
			messages: [{ role: "assistant", content: "## Proposed amendments\n\n- noop" }],
			prompt: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(),
		};
		mockCreateSession.mockResolvedValueOnce({ session: fakeSession } as any);

		const session = makeSession([]);
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: sourcePath,
			},
			{ cwd: tmp },
		);
		expect(result).toContain("forward-looking");
	});

	it("returns an error block when the LLM call throws", async () => {
		mockCreateSession.mockRejectedValueOnce(new Error("no API key"));
		const session = makeSession([captureEvent("p")]);
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: join(tmp, "x.ts"),
			},
			{ cwd: tmp },
		);
		expect(result).toContain("(propose mode failed: LLM call failed: no API key)");
	});

	it("returns an error block when the model produces no text", async () => {
		const fakeSession = {
			agent: { setSystemPrompt: vi.fn() },
			messages: [{ role: "assistant", content: [{ type: "toolCall" }] }],
			prompt: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(),
		};
		mockCreateSession.mockResolvedValueOnce({ session: fakeSession } as any);

		const session = makeSession([captureEvent("p")]);
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: join(tmp, "x.ts"),
			},
			{ cwd: tmp },
		);
		expect(result).toContain("propose mode failed: model produced no text output");
	});

	it("short-circuits on an already-aborted signal without calling the model", async () => {
		const session = makeSession([captureEvent("p")]);
		const ac = new AbortController();
		ac.abort();
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: join(tmp, "x.ts"),
			},
			{ cwd: tmp, signal: ac.signal },
		);
		expect(result).toContain("aborted before LLM call");
		expect(mockCreateSession).not.toHaveBeenCalled();
	});

	it("disposes the session exactly once when aborted between session creation and prompt", async () => {
		// Regression: an earlier version disposed once explicitly inside
		// the post-create abort branch and again in the finally clause,
		// double-disposing on this path. The fix relies on the finally
		// for cleanup; verify dispose is called exactly once.
		const ac = new AbortController();
		const fakeSession = {
			agent: { setSystemPrompt: vi.fn() },
			messages: [],
			prompt: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(),
		};
		// createIsolatedSession resolves successfully, then the signal
		// flips to aborted before we reach the post-create abort check.
		mockCreateSession.mockImplementationOnce(async () => {
			ac.abort();
			return { session: fakeSession } as any;
		});

		const session = makeSession([captureEvent("p")]);
		const result = await generateProposals(
			{
				aggregated: aggregateMetrics([], []),
				sessionMetrics: [],
				hitsBySession: new Map(),
				parsedSessions: [session],
				systemPromptSourcePath: join(tmp, "x.ts"),
			},
			{ cwd: tmp, signal: ac.signal },
		);
		expect(result).toContain("aborted during session setup");
		expect(fakeSession.dispose).toHaveBeenCalledTimes(1);
		expect(fakeSession.prompt).not.toHaveBeenCalled();
	});
});
