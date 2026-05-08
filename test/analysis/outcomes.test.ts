import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	correlateOutcomes,
	parseCommitList,
	parseRecordSeparatedLog,
	type GitRunner,
} from "../../src/analysis/outcomes.js";
import type {
	AnalysisEvent,
	ParsedSession,
	SessionHeader,
} from "../../src/analysis/types.js";

/**
 * The tests inject a stub GitRunner so they never invoke real git.
 * The runner takes (args, cwd) and returns the canned stdout we want
 * for that exact arg list. We assert the runner was called with the
 * right shape only when the test cares about command construction.
 */

interface StubGit {
	runner: GitRunner;
	calls: Array<{ args: string[]; cwd: string }>;
}

function stubGit(handlers: Array<(args: string[]) => string | undefined>): StubGit {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const runner: GitRunner = (args, cwd) => {
		calls.push({ args, cwd });
		for (const h of handlers) {
			const result = h(args);
			if (result !== undefined) return result;
		}
		throw new Error(`unhandled git call: git ${args.join(" ")}`);
	};
	return { runner, calls };
}

describe("parseCommitList", () => {
	it("parses tab-separated sha/iso/subject lines, oldest first", () => {
		const stdout = [
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\t2026-05-08T10:01:00+00:00\tnewer commit",
			"00112233445566778899aabbccddeeff00112233\t2026-05-08T10:00:00+00:00\tolder commit",
		].join("\n");
		const out = parseCommitList(stdout);
		expect(out).toEqual([
			{
				sha: "00112233445566778899aabbccddeeff00112233",
				timestamp: "2026-05-08T10:00:00+00:00",
				subject: "older commit",
			},
			{
				sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
				timestamp: "2026-05-08T10:01:00+00:00",
				subject: "newer commit",
			},
		]);
	});

	it("returns [] on empty stdout", () => {
		expect(parseCommitList("")).toEqual([]);
		expect(parseCommitList("\n\n")).toEqual([]);
	});

	it("ignores malformed lines (no tab separators)", () => {
		expect(parseCommitList("not a real line")).toEqual([]);
	});
});

describe("parseRecordSeparatedLog", () => {
	it("splits records on \\x1F and fields on \\x1E", () => {
		const stdout =
			"sha1\x1ESubject 1\n\nThis reverts commit 1234567890abcdef.\n\x1Fsha2\x1ESubject 2\x1F";
		const out = parseRecordSeparatedLog(stdout);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({
			sha: "sha1",
			body: "Subject 1\n\nThis reverts commit 1234567890abcdef.\n",
		});
		expect(out[1]).toEqual({ sha: "sha2", body: "Subject 2" });
	});

	it("returns [] on empty input", () => {
		expect(parseRecordSeparatedLog("")).toEqual([]);
	});
});

const HEADER_ID = "session-uuid-1";

function makeSession(
	cwd: string,
	startedAt: string,
	events: AnalysisEvent[] = [],
): ParsedSession {
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: HEADER_ID,
		cwd,
		timestamp: startedAt,
	};
	return {
		header,
		events,
		filePath: "/tmp/s.jsonl",
		totalEntries: events.length,
		malformedLines: 0,
	};
}

function toolResult(
	isError: boolean,
	timestamp = "2026-05-08T10:01:00.000Z",
): AnalysisEvent {
	return {
		kind: "tool_result",
		entryId: "e1",
		lineNumber: 2,
		timestamp,
		toolCallId: "tc1",
		toolName: "edit",
		isError,
		contentText: isError ? "fail" : "ok",
	};
}

describe("correlateOutcomes", () => {
	let tmp: string;
	let repoDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-outcomes-"));
		repoDir = join(tmp, "fake-repo");
		mkdirSync(repoDir, { recursive: true });
		// Make it look like a git repo (presence of .git is what
		// `correlateOutcomes` checks; the stub runner means git is never
		// actually invoked).
		mkdirSync(join(repoDir, ".git"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("marks gitUnavailable when cwd is not a git repo", () => {
		const nonRepo = join(tmp, "no-git");
		mkdirSync(nonRepo);
		const session = makeSession(nonRepo, "2026-05-08T10:00:00.000Z");
		const { runner } = stubGit([]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.gitUnavailable).toBe(true);
		expect(out.gitUnavailableReason).toMatch(/not a git repository/);
		expect(out.commitsInWindow).toEqual([]);
	});

	it("marks gitUnavailable when session cwd no longer exists", () => {
		const session = makeSession("/this/path/does/not/exist", "2026-05-08T10:00:00.000Z");
		const { runner } = stubGit([]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.gitUnavailable).toBe(true);
		expect(out.gitUnavailableReason).toMatch(/no longer exists/);
	});

	it("marks gitUnavailable when git config user.email throws", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z");
		const { runner } = stubGit([
			(args) => {
				if (args[0] === "config") throw new Error("git not found");
				return undefined;
			},
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.gitUnavailable).toBe(true);
		expect(out.gitUnavailableReason).toMatch(/git config user\.email failed/);
	});

	it("marks gitUnavailable when user.email is empty", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z");
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "\n" : undefined),
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.gitUnavailable).toBe(true);
		expect(out.gitUnavailableReason).toMatch(/empty/);
	});

	it("returns commits in window and no reverts when no revert log entries", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z", [
			toolResult(false, "2026-05-08T10:30:00.000Z"),
		]);
		const { runner, calls } = stubGit([
			(args) => (args[0] === "config" ? "tester@example.com\n" : undefined),
			(args) => {
				if (
					args[0] === "log" &&
					args.includes("--author=tester@example.com")
				) {
					return [
						"deadbeef00000000000000000000000000000000\t2026-05-08T10:15:00+00:00\tWIP",
						"feedface00000000000000000000000000000000\t2026-05-08T10:20:00+00:00\tFix bug",
					].join("\n");
				}
				return undefined;
			},
			(args) => (args[0] === "log" && args.some((a) => a.startsWith("--grep=")) ? "" : undefined),
		]);
		const out = correlateOutcomes(session, {
			runGit: runner,
			now: new Date("2026-05-08T11:00:00.000Z"),
		});
		expect(out.gitUnavailable).toBe(false);
		expect(out.commitsInWindow.map((c) => c.subject)).toEqual(["Fix bug", "WIP"]);
		expect(out.revertedShas).toEqual([]);
		// Window end should be lastEvent + 5min = 10:35:00
		expect(out.windowEnd).toBe("2026-05-08T10:35:00.000Z");
		// Verify the author filter was actually passed
		expect(
			calls.some(
				(c) =>
					c.args.includes("--author=tester@example.com") &&
					c.args.includes("--since=2026-05-08T10:00:00.000Z"),
			),
		).toBe(true);
	});

	it("flags reverted commits when a later commit message references their SHA", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z");
		const ourSha = "feedface00000000000000000000000000000000";
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "x@y.z\n" : undefined),
			(args) =>
				args.includes("--author=x@y.z")
					? `${ourSha}\t2026-05-08T10:15:00+00:00\tBuggy fix`
					: undefined,
			(args) =>
				args.some((a) => a.startsWith("--grep="))
					? `revertsha000000000000000000000000000000\x1ERevert "Buggy fix"\n\nThis reverts commit ${ourSha}.\n\x1F`
					: undefined,
		]);
		const out = correlateOutcomes(session, {
			runGit: runner,
			now: new Date("2026-05-09T00:00:00.000Z"),
		});
		expect(out.revertedShas).toEqual([ourSha]);
	});

	it("does NOT flag commits whose SHA only appears textually but not in a revert", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z");
		const ourSha = "feedface00000000000000000000000000000000";
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "x@y.z\n" : undefined),
			(args) =>
				args.includes("--author=x@y.z")
					? `${ourSha}\t2026-05-08T10:15:00+00:00\tFix`
					: undefined,
			(args) => (args.some((a) => a.startsWith("--grep=")) ? "" : undefined),
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.revertedShas).toEqual([]);
	});

	it("computes lastToolWasError = true when last tool_result has isError true", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z", [
			toolResult(false, "2026-05-08T10:01:00.000Z"),
			toolResult(true, "2026-05-08T10:02:00.000Z"),
		]);
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "x@y.z\n" : undefined),
			(args) => (args[0] === "log" ? "" : undefined),
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.lastToolWasError).toBe(true);
	});

	it("computes lastToolWasError = false when last tool_result was successful", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z", [
			toolResult(true, "2026-05-08T10:01:00.000Z"),
			toolResult(false, "2026-05-08T10:02:00.000Z"),
		]);
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "x@y.z\n" : undefined),
			(args) => (args[0] === "log" ? "" : undefined),
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.lastToolWasError).toBe(false);
	});

	it("computes lastToolWasError = null when session has no tool_result events", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z", []);
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "x@y.z\n" : undefined),
			(args) => (args[0] === "log" ? "" : undefined),
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.lastToolWasError).toBeNull();
	});

	it("falls back to start+5min for windowEnd when no events have parseable timestamps", () => {
		const session = makeSession(repoDir, "2026-05-08T10:00:00.000Z", [
			{
				kind: "tool_result",
				entryId: "e",
				lineNumber: 2,
				timestamp: "not-a-date",
				toolCallId: "tc",
				toolName: "x",
				isError: false,
				contentText: "",
			},
		]);
		const { runner } = stubGit([
			(args) => (args[0] === "config" ? "x@y.z\n" : undefined),
			(args) => (args[0] === "log" ? "" : undefined),
		]);
		const out = correlateOutcomes(session, { runGit: runner });
		expect(out.windowEnd).toBe("2026-05-08T10:05:00.000Z");
	});
});

describe("correlateOutcomes — write-fixture-then-fake-repo (no real git)", () => {
	it("uses session.cwd to invoke git in the right directory", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-out-cwd-"));
		try {
			const repoDir = join(tmp, "alpha");
			mkdirSync(repoDir, { recursive: true });
			mkdirSync(join(repoDir, ".git"), { recursive: true });

			const session: ParsedSession = {
				header: {
					type: "session",
					version: 3,
					id: "test",
					cwd: repoDir,
					timestamp: "2026-05-08T10:00:00.000Z",
				},
				events: [],
				filePath: "/tmp/s.jsonl",
				totalEntries: 0,
				malformedLines: 0,
			};
			const { runner, calls } = stubGit([
				(args) => (args[0] === "config" ? "x@y.z" : undefined),
				(args) => (args[0] === "log" ? "" : undefined),
			]);
			correlateOutcomes(session, { runGit: runner });
			for (const c of calls) {
				expect(c.cwd).toBe(repoDir);
			}
			// Place a sentinel file so cleanup works without surprises.
			writeFileSync(join(repoDir, ".sentinel"), "");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
