import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisEvent, ParsedSession } from "./types.js";

/**
 * Per-session outcome data. Answers the question: "did this session
 * actually land work, did it end cleanly, and did anything get reverted
 * later?"
 *
 * The data is **approximate**: commit attribution is by timestamp
 * window + author email, not exact. Two overlapping sessions on the
 * same minute would be assigned the same commits. The renderer should
 * present these as signals, not ground truth.
 */
export interface OutcomeData {
	sessionId: string;
	cwd: string;
	/** ISO timestamps bounding the git-log query, inclusive of a 5min tail. */
	windowStart: string;
	windowEnd: string;
	/** Git was unavailable / cwd is not a git repo / git config missing. */
	gitUnavailable: boolean;
	/** Reason the lookup was skipped, populated only when gitUnavailable. */
	gitUnavailableReason?: string;
	/** Commits authored by the user in the time window, oldest first. */
	commitsInWindow: Array<{ sha: string; subject: string; timestamp: string }>;
	/** Subset of commitsInWindow that were reverted in the look-back range. */
	revertedShas: string[];
	/**
	 * `true` when the LAST tool_result event in the session has
	 * `isError: true`. `false` when it has `isError: false`. `null` when
	 * the session contains no tool_result events at all (rare; usually
	 * a session that the user aborted before the agent ran any tool).
	 */
	lastToolWasError: boolean | null;
}

/**
 * Type signature for the git-runner injection point. Tests stub this
 * to avoid invoking real git. Production uses `defaultRunGit` which
 * spawns git via execFileSync against the session's cwd.
 *
 * The runner returns stdout. Errors (non-zero exit, missing git,
 * cwd-is-not-a-repo) are propagated as thrown Errors; correlateOutcomes
 * catches them and marks the outcome `gitUnavailable`.
 */
export type GitRunner = (args: string[], cwd: string) => string;

export const defaultRunGit: GitRunner = (args, cwd) => {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024,
	});
};

export interface CorrelateOptions {
	runGit?: GitRunner;
	/** Look-back window for revert detection. Default: 30 days from now. */
	revertLookbackMs?: number;
	/** Override clock for deterministic tests. */
	now?: Date;
}

/**
 * Correlate one parsed session with the git history of its cwd.
 *
 * Strategy:
 *  1. Determine the time window: [session start, last event + 5min].
 *  2. Get the git user.email once. If git is unavailable or the cwd
 *     isn't a repo, return `gitUnavailable: true` with no commits.
 *  3. List commits authored by that email in the window.
 *  4. For revert detection, list commits in the look-back window whose
 *     message starts with "Revert ", then check whether each session
 *     commit's full SHA appears in any revert message body. Git's
 *     `revert` produces a body like `This reverts commit <sha>.`
 *  5. Inspect the last tool_result event to determine `lastToolWasError`.
 */
export function correlateOutcomes(
	session: ParsedSession,
	options: CorrelateOptions = {},
): OutcomeData {
	const runGit = options.runGit ?? defaultRunGit;
	const now = options.now ?? new Date();
	const revertLookbackMs = options.revertLookbackMs ?? 30 * 86_400_000;

	const start = session.header.timestamp;
	const end = computeWindowEnd(session.events, start);
	const lastToolWasError = computeLastToolWasError(session.events);

	const cwd = session.header.cwd;
	if (!cwd || !existsSync(cwd) || !isGitRepo(cwd)) {
		return {
			sessionId: session.header.id,
			cwd,
			windowStart: start,
			windowEnd: end,
			gitUnavailable: true,
			gitUnavailableReason: !cwd
				? "session header has no cwd"
				: !existsSync(cwd)
					? "session cwd no longer exists"
					: "cwd is not a git repository",
			commitsInWindow: [],
			revertedShas: [],
			lastToolWasError,
		};
	}

	let userEmail: string;
	try {
		userEmail = runGit(["config", "user.email"], cwd).trim();
	} catch (err) {
		return {
			sessionId: session.header.id,
			cwd,
			windowStart: start,
			windowEnd: end,
			gitUnavailable: true,
			gitUnavailableReason: `git config user.email failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
			commitsInWindow: [],
			revertedShas: [],
			lastToolWasError,
		};
	}

	if (!userEmail) {
		return {
			sessionId: session.header.id,
			cwd,
			windowStart: start,
			windowEnd: end,
			gitUnavailable: true,
			gitUnavailableReason: "git config user.email is empty",
			commitsInWindow: [],
			revertedShas: [],
			lastToolWasError,
		};
	}

	let commitsInWindow: OutcomeData["commitsInWindow"] = [];
	try {
		const stdout = runGit(
			[
				"log",
				`--since=${start}`,
				`--until=${end}`,
				`--author=${userEmail}`,
				"--pretty=format:%H%x09%cI%x09%s",
			],
			cwd,
		);
		commitsInWindow = parseCommitList(stdout);
	} catch (err) {
		// Empty range or other non-fatal errors return no commits but the
		// outcome record is still valid; we don't mark gitUnavailable.
		commitsInWindow = [];
	}

	let revertedShas: string[] = [];
	if (commitsInWindow.length > 0) {
		try {
			const sinceIso = new Date(now.getTime() - revertLookbackMs).toISOString();
			const stdout = runGit(
				[
					"log",
					`--since=${sinceIso}`,
					"--grep=^Revert ",
					"--pretty=format:%H%x1E%B%x1F",
				],
				cwd,
			);
			const revertMessages = parseRecordSeparatedLog(stdout);
			const sessionShas = new Set(commitsInWindow.map((c) => c.sha));
			for (const { body } of revertMessages) {
				// Git's `revert` emits "This reverts commit <full-sha>." Match
				// any 40-hex token in the body that is one of our shas.
				const matches = body.match(/\b[0-9a-f]{40}\b/gi);
				if (!matches) continue;
				for (const m of matches) {
					if (sessionShas.has(m)) revertedShas.push(m);
				}
			}
			// De-duplicate while preserving original commit order.
			const seen = new Set(revertedShas);
			revertedShas = commitsInWindow
				.filter((c) => seen.has(c.sha))
				.map((c) => c.sha);
		} catch {
			revertedShas = [];
		}
	}

	return {
		sessionId: session.header.id,
		cwd,
		windowStart: start,
		windowEnd: end,
		gitUnavailable: false,
		commitsInWindow,
		revertedShas,
		lastToolWasError,
	};
}

/**
 * The window end is `last event timestamp + 5 min` if any event has a
 * parseable timestamp; otherwise we use the start. The 5-minute tail
 * forgives the gap between the last logged event and the user's actual
 * git commit (which often happens right after the agent's last action).
 */
function computeWindowEnd(events: AnalysisEvent[], startIso: string): string {
	for (let i = events.length - 1; i >= 0; i--) {
		const t = Date.parse(events[i].timestamp);
		if (Number.isFinite(t)) return new Date(t + 5 * 60_000).toISOString();
	}
	const start = Date.parse(startIso);
	if (Number.isFinite(start)) return new Date(start + 5 * 60_000).toISOString();
	return startIso;
}

function computeLastToolWasError(events: AnalysisEvent[]): boolean | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.kind === "tool_result") return ev.isError;
	}
	return null;
}

function isGitRepo(cwd: string): boolean {
	try {
		const dotGit = join(cwd, ".git");
		return existsSync(dotGit) && (statSync(dotGit).isDirectory() || statSync(dotGit).isFile());
	} catch {
		return false;
	}
}

/**
 * Parse `git log --pretty=format:%H%x09%cI%x09%s` output.
 *
 * Each line: `<sha>\t<commit-iso>\t<subject>`. Empty lines skipped.
 */
export function parseCommitList(
	stdout: string,
): Array<{ sha: string; subject: string; timestamp: string }> {
	const out: Array<{ sha: string; subject: string; timestamp: string }> = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const tabIdx1 = line.indexOf("\t");
		if (tabIdx1 === -1) continue;
		const tabIdx2 = line.indexOf("\t", tabIdx1 + 1);
		if (tabIdx2 === -1) continue;
		const sha = line.slice(0, tabIdx1);
		const timestamp = line.slice(tabIdx1 + 1, tabIdx2);
		const subject = line.slice(tabIdx2 + 1);
		out.push({ sha, subject, timestamp });
	}
	// Reverse so older commits come first (git log returns newest first).
	return out.reverse();
}

/**
 * Parse a custom record-separated git log: `%H\x1E%B\x1F` per commit.
 *
 * `\x1E` separates fields within a record; `\x1F` separates records.
 * Using control characters avoids ambiguity with newlines that may
 * appear in commit message bodies.
 */
export function parseRecordSeparatedLog(
	stdout: string,
): Array<{ sha: string; body: string }> {
	const records = stdout.split("\x1F").filter((r) => r.trim().length > 0);
	const out: Array<{ sha: string; body: string }> = [];
	for (const record of records) {
		const sepIdx = record.indexOf("\x1E");
		if (sepIdx === -1) continue;
		const sha = record.slice(0, sepIdx).trim();
		const body = record.slice(sepIdx + 1);
		if (sha) out.push({ sha, body });
	}
	return out;
}
