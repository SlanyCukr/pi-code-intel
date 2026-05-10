import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { aggregateMetrics, extractMetrics } from "./metrics.js";
import { correlateOutcomes, type OutcomeData } from "./outcomes.js";
import { runAllRules } from "./patterns/index.js";
import { generateProposals } from "./propose.js";
import { readSession } from "./reader.js";
import { renderMarkdown } from "./report.js";
import type { AntiPatternHit, ParsedSession } from "./types.js";

/**
 * `__dirname` for this module after compilation: `<dist>/analysis/`.
 * Used to resolve sibling assets shipped via copy-assets.ts.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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
	/** When true, run the LLM-driven proposer and render section 5. */
	propose?: boolean;
	/**
	 * When set, retain only hits whose `ruleId` is in this list. All rules
	 * still run (cheap, pure functions); the filter applies post-hoc to
	 * what surfaces in section 3 and what propose mode sees in section 5.
	 * Aggregated metrics are unaffected — the operator still gets full
	 * activity context even when narrowing focus to one rule.
	 */
	rules?: string[];
}

export interface AnalysisResult {
	reportMarkdown: string;
	/** Resolved output path; null when `--no-write` was passed. */
	outPath: string | null;
	sessionFilesAnalyzed: string[];
	sessionFilesSkipped: string[];
}

/**
 * Runtime options separate from operator-supplied `AnalysisArgs`.
 *
 * `signal` is intentionally NOT in `AnalysisArgs`: the latter is the
 * shape of CLI/operator input, parsed from argv. The signal is a
 * caller-side cancellation handle that flows in alongside, matching the
 * `(input, options)` shape used by `generateProposals` and `runSubAgent`.
 */
export interface AnalysisOptions {
	/** Aborts the in-flight propose-mode LLM call when triggered. */
	signal?: AbortSignal;
}

/**
 * Run the full analysis pipeline end-to-end.
 *
 * Steps:
 *  1. Locate the session directory for `cwd`.
 *  2. Enumerate `.jsonl` files honoring `sinceMs` and `sessionId`
 *     filters.
 *  3. Parse each file. Files that fail to parse are recorded in
 *     `sessionFilesSkipped` with a stderr warning, but don't abort
 *     the run — one corrupted session shouldn't kill the report.
 *  4. Compute per-session metrics + run all anti-pattern rules.
 *  5. Aggregate metrics across sessions.
 *  6. (Optional) Generate LLM-driven prompt amendment proposals.
 *  7. Render markdown.
 *  8. Write to disk (unless `noWrite`); always return the markdown.
 *
 * Step 6 is async (LLM call) — that's why this function is now async.
 * The propose step only runs when `args.propose === true`; otherwise
 * the function is effectively still synchronous.
 *
 * `options.signal`, when provided, aborts the propose-mode LLM call.
 * The synchronous parts (file enumeration, parsing, metrics, outcome
 * correlation) are not signal-aware — they complete or throw on their
 * own. This matches how `generateProposals` already exposes signal
 * handling and is the only step that can stall on remote IO.
 */
export async function runAnalysis(
	args: AnalysisArgs,
	options: AnalysisOptions = {},
): Promise<AnalysisResult> {
	// Always resolve cwd to an absolute path: pi stores absolute cwds in
	// its session subdirectory names, so a relative input like "." or
	// "./proj" would be encoded as `--.--` / `--.-proj--` and find no
	// sessions despite the dir existing. Normalizing here protects both
	// the CLI entry and any programmatic caller.
	const cwd = resolve(args.cwd);
	const sessionsDir = resolveSessionsDir(cwd);
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
	const ruleFilter = args.rules ? new Set(args.rules) : null;
	const hitsBySession = new Map<string, AntiPatternHit[]>();
	for (const session of parsed) {
		const allHits = runAllRules(session);
		const filtered = ruleFilter
			? allHits.filter((h) => ruleFilter.has(h.ruleId))
			: allHits;
		hitsBySession.set(session.header.id, filtered);
	}

	// Outcome correlation runs per session. Each invocation may shell
	// out to git twice (commits-in-window + revert-search) against the
	// session's cwd. For a one-off tool with N ≤ ~50 sessions this is
	// fast enough; if it ever becomes hot we can hoist the revert search.
	//
	// Sub-agent sessions share the parent's cwd and overlap its time
	// window — correlating them would attribute the parent's commits to
	// every sub-agent that ran during the parent. Skip them entirely;
	// the parent's outcome row already covers the work.
	const outcomesBySession = new Map<string, OutcomeData>();
	for (const session of parsed) {
		if (session.isSubAgent) continue;
		outcomesBySession.set(session.header.id, correlateOutcomes(session));
	}

	const aggregated = aggregateMetrics(
		perSession,
		parsed.map((p) => p.events),
	);

	let proposalsMarkdown: string | undefined;
	if (args.propose) {
		proposalsMarkdown = await generateProposals(
			{
				aggregated,
				sessionMetrics: perSession,
				hitsBySession,
				parsedSessions: parsed,
				systemPromptSourcePath: resolveSystemPromptFallback(cwd),
			},
			{
				cwd: cwd,
				signal: options.signal,
			},
		);
	}

	const reportMarkdown = renderMarkdown({
		generatedAt: new Date(),
		sessionMetrics: perSession,
		aggregated,
		hitsBySession,
		outcomesBySession,
		proposalsMarkdown,
		parsedSessions: parsed,
	});

	let outPath: string | null = null;
	if (!args.noWrite) {
		outPath = args.out ?? defaultReportPath(cwd);
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
 * Where to find the system-prompt source for propose-mode fallback.
 *
 * Search order:
 * 1. `<dist>/prompt/system-prompt.source.ts` — shipped by copy-assets.
 *    This is the path that works when the extension is installed as
 *    a compiled package (the analyzed project doesn't vendor our src/).
 * 2. `<analyzed-project>/src/prompt/system-prompt.ts` — only useful
 *    when the operator is analyzing this very repo's own checkout.
 *    Kept as a secondary path so dev iteration on the source still
 *    surfaces the latest content even if the dist hasn't been rebuilt.
 *
 * If neither path exists, the propose mode emits a clear `(skipped:...)`
 * placeholder rather than failing.
 */
export function resolveSystemPromptFallback(analyzedCwd: string): string {
	const bundled = join(MODULE_DIR, "..", "prompt", "system-prompt.source.ts");
	if (existsSync(bundled)) return bundled;
	return join(analyzedCwd, "src", "prompt", "system-prompt.ts");
}

/**
 * Encode a working-directory path the way pi-coding-agent does for its
 * session subdirectories. This MUST match pi's encoding exactly or the
 * analyzer will look in the wrong directory and silently report "no
 * sessions found."
 *
 * Mirrors the SDK's `getDefaultSessionDir` implementation exactly
 * (node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js):
 *
 *   safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 *
 * The two operations:
 *   1. Strip ONE leading slash or backslash (path-style independent).
 *   2. Replace any remaining slash, backslash, or COLON with `-`.
 *
 * Colons matter on Windows (drive letters: `C:\...`) and on Unix paths
 * containing colons (e.g. `/tmp/foo:bar`). An earlier version of this
 * encoder only replaced `/`, which produced wrong directory names for
 * those cases and silently lost their sessions. Codex round-5 caught
 * this; the fix imports no SDK private code and instead mirrors the
 * one-line transformation byte-for-byte. If the SDK ever changes its
 * encoding, this is the single place that must be updated.
 */
export function encodeSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Resolve the absolute path to the pi sessions directory for a given
 * working directory.
 *
 * Uses the SDK's `getAgentDir()` so this honors the `PI_CODING_AGENT_DIR`
 * (and forks-of-pi equivalents like `TAU_CODING_AGENT_DIR`) environment
 * variable. Hardcoding `~/.pi/agent` would silently miss every session
 * for users who relocate their agent dir — the analyzer would print
 * "no sessions found" despite the data being present elsewhere.
 */
export function resolveSessionsDir(cwd: string): string {
	return join(getAgentDir(), "sessions", encodeSessionDirName(cwd));
}

/**
 * Enumerate session JSONL files in `sessionsDir`, applying time and
 * session-id filters.
 *
 * Sessions are ordered by mtime ascending (oldest first). This is the
 * order in which they were created, which makes the report's per-rule
 * sample listings naturally chronological.
 *
 * Also descends into one fixed subdirectory: `<sessionsDir>/subagents/`.
 * Pi persists sub-agent sessions there (see
 * `agents/runner.ts createSessionStorage`); without this descent the
 * analyzer silently misses every delegated task. Sub-agents cannot
 * themselves spawn nested agents (the agent tool is not registered when
 * `isInSubAgent()` is true — see `extension.ts`), so one level is
 * sufficient and we deliberately do not recurse further.
 */
function listSessionFiles(sessionsDir: string, args: AnalysisArgs): string[] {
	if (!existsSync(sessionsDir)) {
		return []; // no sessions for this cwd yet — empty analysis
	}

	const cutoffMs = args.sinceMs !== undefined ? Date.now() - args.sinceMs : 0;

	const collect = (dir: string): Array<{ full: string; name: string; mtimeMs: number }> =>
		readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => {
				const full = join(dir, name);
				const st = statSync(full);
				return { full, name, mtimeMs: st.mtimeMs };
			});

	const all = collect(sessionsDir);
	const subagentsDir = join(sessionsDir, "subagents");
	if (existsSync(subagentsDir)) {
		all.push(...collect(subagentsDir));
	}
	const entries = all
		.filter(({ mtimeMs }) => mtimeMs >= cutoffMs)
		.sort((a, b) => a.mtimeMs - b.mtimeMs);

	if (args.sessionId !== undefined) {
		// Pi session filenames look like `<timestamp>_<uuid>.jsonl`.
		// We only want to prefix-match against the UUID, not the timestamp:
		// otherwise a value like `--session 2026` would match every session
		// from that year. Split on the last underscore so timestamps that
		// happen to contain underscores still resolve correctly.
		const sessionId = args.sessionId;
		return entries
			.filter(({ name }) => {
				const base = name.replace(/\.jsonl$/i, "");
				const underscoreIdx = base.lastIndexOf("_");
				const uuidPart = underscoreIdx >= 0 ? base.slice(underscoreIdx + 1) : base;
				return uuidPart.startsWith(sessionId);
			})
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
 * Returns null on unrecognized input. The CLI treats null as a hard
 * error and exits 2 so a typo cannot silently expand the analysis
 * window to "all sessions" (see `cli-main.ts` --since handling).
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
