import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { aggregateMetrics, extractMetrics } from "./metrics.js";
import { correlateOutcomes, type OutcomeData } from "./outcomes.js";
import { runAllRules } from "./patterns/index.js";
import { readSession } from "./reader.js";
import { renderMarkdown } from "./report.js";
import type { AntiPatternHit, ParsedSession } from "./types.js";

/**
 * CLI input — parsed shape consumed by `runAnalysis`.
 *
 * Validation of `since` and other operator-supplied values is done by
 * the parser (see `parseArgs` in `scripts/analyze-sessions.ts`); by
 * the time we get here, fields are already normalized.
 */
export interface AnalysisArgs {
	/**
	 * Working directory whose sessions we analyze. Used to locate the
	 * pi sessions directory under `~/.pi/agent/sessions/`.
	 *
	 * Defaults to `process.cwd()` at the call site.
	 */
	cwd: string;
	/** Filter sessions by mtime: only files newer than `now - sinceMs`. */
	sinceMs?: number;
	/** Filter to one specific session by UUID prefix match. */
	sessionId?: string;
	/** Output path; defaults to `<cwd>/.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md`. */
	out?: string;
	/** When true, only print to stdout; do not write to disk. */
	noWrite?: boolean;
	/** Phase 6 — request the propose section. Currently a stub. */
	propose?: boolean;
}

export interface AnalysisResult {
	reportMarkdown: string;
	/** Resolved output path; null when `--no-write` was passed. */
	outPath: string | null;
	sessionFilesAnalyzed: string[];
	sessionFilesSkipped: string[];
}

/**
 * Run the full analysis pipeline end-to-end.
 *
 * Steps:
 *  1. Locate the session directory for `args.cwd`.
 *  2. Enumerate `.jsonl` files honoring `sinceMs` and `sessionId`
 *     filters.
 *  3. Parse each file. Files that fail to parse are recorded in
 *     `sessionFilesSkipped` with a stderr warning, but don't abort
 *     the run — one corrupted session shouldn't kill the report.
 *  4. Compute per-session metrics + run all anti-pattern rules.
 *  5. Aggregate metrics across sessions.
 *  6. Render markdown.
 *  7. Write to disk (unless `noWrite`); always return the markdown.
 */
export function runAnalysis(args: AnalysisArgs): AnalysisResult {
	const sessionsDir = resolveSessionsDir(args.cwd);
	const candidates = listSessionFiles(sessionsDir, args);
	const parsed: ParsedSession[] = [];
	const skipped: string[] = [];

	for (const file of candidates) {
		try {
			parsed.push(readSession(file));
		} catch (err) {
			skipped.push(file);
			console.error(
				`[analyze-sessions] skipping ${file}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	const perSession = parsed.map(extractMetrics);
	const hitsBySession = new Map<string, AntiPatternHit[]>();
	for (const session of parsed) {
		hitsBySession.set(session.header.id, runAllRules(session));
	}

	// Outcome correlation runs per session. Each invocation may shell
	// out to git twice (commits-in-window + revert-search) against the
	// session's cwd. For a one-off tool with N ≤ ~50 sessions this is
	// fast enough; if it ever becomes hot we can hoist the revert search.
	const outcomesBySession = new Map<string, OutcomeData>();
	for (const session of parsed) {
		outcomesBySession.set(session.header.id, correlateOutcomes(session));
	}

	const aggregated = aggregateMetrics(
		perSession,
		parsed.map((p) => p.events),
	);

	const reportMarkdown = renderMarkdown({
		generatedAt: new Date(),
		sessionMetrics: perSession,
		aggregated,
		hitsBySession,
		outcomesBySession,
	});

	let outPath: string | null = null;
	if (!args.noWrite) {
		outPath = args.out ?? defaultReportPath(args.cwd);
		const outDir = outPath.substring(0, outPath.lastIndexOf("/"));
		if (outDir) mkdirSync(outDir, { recursive: true });
		writeFileSync(outPath, reportMarkdown, "utf-8");
	}

	return {
		reportMarkdown,
		outPath,
		sessionFilesAnalyzed: parsed.map((p) => p.filePath),
		sessionFilesSkipped: skipped,
	};
}

/**
 * Encode a working-directory path the way pi-coding-agent does for its
 * session subdirectories: leading `--`, replace `/` with `-`, trailing
 * `--`. This must match pi's encoding exactly or we won't find the
 * sessions. Verified against actual pi sessions on disk.
 */
export function encodeSessionDirName(cwd: string): string {
	const normalized = cwd.replace(/\/+$/g, ""); // strip trailing slashes
	return `-${normalized.replace(/\//g, "-")}--`;
}

/**
 * Resolve the absolute path to the pi sessions directory for a given
 * working directory.
 */
export function resolveSessionsDir(cwd: string): string {
	return join(homedir(), ".pi", "agent", "sessions", encodeSessionDirName(cwd));
}

/**
 * Enumerate session JSONL files in `sessionsDir`, applying time and
 * session-id filters.
 *
 * Sessions are ordered by mtime ascending (oldest first). This is the
 * order in which they were created, which makes the report's per-rule
 * sample listings naturally chronological.
 */
function listSessionFiles(sessionsDir: string, args: AnalysisArgs): string[] {
	if (!existsSync(sessionsDir)) {
		return []; // no sessions for this cwd yet — empty analysis
	}

	const cutoffMs = args.sinceMs !== undefined ? Date.now() - args.sinceMs : 0;

	const entries = readdirSync(sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => {
			const full = join(sessionsDir, name);
			const st = statSync(full);
			return { full, name, mtimeMs: st.mtimeMs };
		})
		.filter(({ mtimeMs }) => mtimeMs >= cutoffMs)
		.sort((a, b) => a.mtimeMs - b.mtimeMs);

	if (args.sessionId !== undefined) {
		// Match by UUID-prefix: the filename includes the UUID after the
		// timestamp (e.g. 2026-05-08T...Z_<uuid>.jsonl). Match anywhere
		// in the filename so prefixes work regardless of the timestamp.
		return entries
			.filter(({ name }) => name.includes(args.sessionId!))
			.map(({ full }) => full);
	}

	return entries.map(({ full }) => full);
}

/**
 * Compute the default output path:
 *   <cwd>/.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md
 *
 * The HHMMSS suffix lets multiple runs on the same day coexist.
 */
export function defaultReportPath(cwd: string, now: Date = new Date()): string {
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const HH = String(now.getHours()).padStart(2, "0");
	const MM = String(now.getMinutes()).padStart(2, "0");
	const SS = String(now.getSeconds()).padStart(2, "0");
	return join(cwd, ".pi", "analyses", `${yyyy}-${mm}-${dd}_${HH}${MM}${SS}.md`);
}

/**
 * Parse a duration string like `7d`, `24h`, `30m`, `2w` into ms.
 * Returns null on unrecognized input — the CLI treats null as "no
 * filter" rather than throwing, so a typo doesn't abort a run.
 */
export function parseDuration(s: string): number | null {
	const m = s.trim().match(/^(\d+)\s*([smhdw])$/i);
	if (!m) return null;
	const n = Number.parseInt(m[1], 10);
	const unit = m[2].toLowerCase();
	switch (unit) {
		case "s":
			return n * 1000;
		case "m":
			return n * 60_000;
		case "h":
			return n * 3_600_000;
		case "d":
			return n * 86_400_000;
		case "w":
			return n * 7 * 86_400_000;
	}
	return null;
}
