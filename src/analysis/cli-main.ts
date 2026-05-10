#!/usr/bin/env node
/**
 * Executable entry point for `pi session analysis`.
 *
 * After `npm run build` this becomes `dist/analysis/cli-main.js`.
 * Run via:
 *
 *   node dist/analysis/cli-main.js [options]
 *
 * All real logic lives in `cli.ts`; this file is the argv parser +
 * stdout/stderr glue. We deliberately do NOT support running it from
 * the source `.ts` form (`node --experimental-strip-types`) because
 * value imports with `.js` extensions don't resolve before tsc has
 * compiled the tree. Build first, then run.
 */
import { parseArgs } from "node:util";
import { runAnalysis, parseDuration } from "./cli.js";
import { RULE_IDS } from "./patterns/index.js";

async function main(argv: string[]): Promise<number> {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				cwd: { type: "string" },
				since: { type: "string" },
				session: { type: "string" },
				out: { type: "string" },
				"no-write": { type: "boolean", default: false },
				quiet: { type: "boolean", short: "q", default: false },
				propose: { type: "boolean", default: false },
				rules: { type: "string" },
				help: { type: "boolean", short: "h", default: false },
			},
			allowPositionals: false,
			strict: true,
		});
	} catch (err) {
		console.error(
			`[analyze-sessions] ${err instanceof Error ? err.message : String(err)}`,
		);
		printHelp(process.stderr);
		return 2;
	}

	const values = parsed.values;
	if (values.help) {
		printHelp(process.stdout);
		return 0;
	}

	let sinceMs: number | undefined;
	if (typeof values.since === "string") {
		const ms = parseDuration(values.since);
		if (ms === null) {
			console.error(
				`[analyze-sessions] --since "${values.since}" not understood. Use forms like 7d, 24h, 30m, 2w.`,
			);
			return 2;
		}
		sinceMs = ms;
	}

	let rules: string[] | undefined;
	if (typeof values.rules === "string") {
		const requested = values.rules
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const known = new Set<string>(RULE_IDS);
		const unknown = requested.filter((id) => !known.has(id));
		if (unknown.length > 0) {
			console.error(
				`[analyze-sessions] --rules: unknown rule id(s): ${unknown.join(", ")}.\nKnown rules: ${RULE_IDS.join(", ")}`,
			);
			return 2;
		}
		rules = requested;
	}

	const result = await runAnalysis({
		cwd: typeof values.cwd === "string" ? values.cwd : process.cwd(),
		sinceMs,
		sessionId: typeof values.session === "string" ? values.session : undefined,
		out: typeof values.out === "string" ? values.out : undefined,
		noWrite: values["no-write"] === true,
		propose: values.propose === true,
		rules,
	});

	if (values.quiet !== true) {
		process.stdout.write(result.reportMarkdown);
		if (!result.reportMarkdown.endsWith("\n")) process.stdout.write("\n");
	}

	if (result.outPath) {
		console.error(`[analyze-sessions] report written to ${result.outPath}`);
	}
	if (result.sessionFilesSkipped.length > 0) {
		console.error(
			`[analyze-sessions] ${result.sessionFilesSkipped.length} session file(s) skipped due to parse errors`,
		);
	}
	return 0;
}

function printHelp(stream: NodeJS.WritableStream): void {
	stream.write(`Usage: analyze-sessions [options]

Analyze pi-coding-agent session JSONL logs for code-search efficiency,
recurring anti-patterns, git outcome correlation, and (with --propose)
LLM-driven prompt-amendment proposals.

Options:
  --cwd <path>          Working directory whose sessions to analyze.
                        Default: process.cwd().
  --since <duration>    Filter to sessions newer than this. Forms: 7d,
                        24h, 30m, 2w. Default: all sessions.
  --session <id>        Filter to one specific session by UUID prefix
                        (matches the UUID portion of the filename only;
                        timestamps in the prefix are ignored).
  --out <path>          Override report output path. Default:
                        <cwd>/.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md
  --no-write            Print to stdout only; do not write to disk.
  -q, --quiet           Suppress stdout output. Disk write still happens
                        unless --no-write is also passed.
  --rules <ids>         Comma-separated rule ids to keep in section 3
                        and propose mode. Other rules' hits are dropped.
                        Aggregated metrics are unaffected. Known rules:
                        read-twice-no-edit, grep-for-symbol,
                        read-after-document-symbols,
                        edit-failure-then-reread, bash-sed-or-awk-edit,
                        bash-cat-or-head-or-tail,
                        read-after-grep-same-file.
  --propose             Append section 5 with LLM-proposed prompt
                        amendments. Makes a real model call — the
                        model is selected from your pi settings or
                        the first available model with credentials.
  -h, --help            Print this help.
`);
}

main(process.argv.slice(2)).then(
	(exitCode) => process.exit(exitCode),
	(err) => {
		console.error(
			`[analyze-sessions] fatal: ${err instanceof Error ? err.message : String(err)}`,
		);
		if (err instanceof Error && err.stack) console.error(err.stack);
		process.exit(1);
	},
);
