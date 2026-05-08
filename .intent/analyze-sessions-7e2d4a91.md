# Intent: One-off session analysis tool with prompt-amendment proposals

**Created**: 2026-05-08
**ID**: analyze-sessions-7e2d4a91

---

## Problem Statement

Every pi session is logged as JSONL under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`. The data is rich — every tool call, every result, every error, every token of every assistant message. Today nothing consumes this analytically. The only existing reader (`scripts/parse-session.py`) summarizes a single session for human reading.

We want a one-off CLI that, when invoked, surfaces:

1. **How efficient was code search?** Are we leaning on `read`/`grep` when `lsp` would have answered with one call?
2. **What anti-patterns are recurring?** Stale-file edit failures, redundant reads, grep-for-symbol when `workspace_symbols` is the right tool.
3. **Did the work actually land?** Did the session produce a commit? Did it end on an error? Did a later session revert it?
4. **What should change in the system prompt or tool descriptions** to prevent the worst recurring patterns?

This is explicitly **not** a daemon, a watcher, or a background telemetry pipeline. It is a script the operator invokes when they want to look. Each invocation is independent of every prior one; no incremental state is kept beyond the produced report.

## Scope

**In scope:**
- A TypeScript CLI runnable as `node dist/analysis/cli-main.js [args]` after `npm run build`. The entry point lives in `src/analysis/cli-main.ts` and is compiled into the regular `dist/` tree alongside its dependencies.
- Core analysis logic factored into `src/analysis/` for testability; `cli-main.ts` is a thin argv-to-function shim. (We do NOT mirror the `scripts/copy-assets.ts` precedent of running source `.ts` directly via `--experimental-strip-types`: that works for build-time helpers using only Node-builtin imports, but value imports from `src/` with `.js` extensions don't resolve before tsc has produced them. Build-then-run is the honest pattern.)
- Five report sections, each gated by a flag so callers can scope the output:
  - **Summary**: N sessions analyzed, total tool calls, top tools by frequency, total turns, total assistant tokens (where available).
  - **Efficiency**: `read:lsp` ratio, `grep:lsp` ratio, edit-failure rate, average reads per session, average tool calls per session.
  - **Anti-patterns**: Each rule reports flagged sequences with `session_id` + JSONL line refs and a one-line explanation. Initial rule set listed in Architectural Decisions below.
  - **Outcomes**: Per-session: timestamp range, did it produce a commit (correlation against `git log` in cwd), was the session's last `toolResult` an error, did a later commit revert one of this session's commits.
  - **Propose**: An optional LLM pass that takes the top-K flagged anti-pattern hits plus the current `src/prompt/system-prompt.ts` source and produces a markdown section with proposed amendments (prose explanation + suggested diffs). Gated behind `--propose` because it makes a model call.
- Output: a single markdown report at `.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md` (timestamp suffix permits multiple runs the same day). The report is also printed to stdout.
- A slash command `/analyze-sessions` that wraps the script (markdown template under `src/commands/templates/analyze-sessions.md`), mirroring the precedent established by `feature-dev` and `review-pr`.
- Unit tests for the reader, metrics extractor, each anti-pattern rule, the outcome correlator (with stubbed git), and the report renderer. The propose-mode LLM call is NOT unit-tested end-to-end (it makes a real model call); only its prompt-builder and response-parser are tested.

**Out of scope:**
- Background or scheduled operation. Each run is operator-initiated.
- Cross-machine aggregation. The tool reads sessions from the local pi sessions directory only.
- Persistent metrics database / time-series storage. Reports are markdown files; diffing is the operator's job.
- Ground-truth labelling of "was a bug introduced". The tool surfaces signals (revert commits, error-tail sessions, follow-up "fix" sessions) but does not claim ground truth.
- Modifying the system prompt or tool descriptions automatically. `--propose` produces a draft for human review; it never writes to source files.

## Architectural Decisions

### Decision: Logic in `src/analysis/`, CLI shim in `scripts/`
**Chosen approach**: All analysis logic lives in `src/analysis/` as importable modules. `scripts/analyze-sessions.ts` is a ~30-line shim that parses argv and calls `runAnalysis(args)`.
**Rationale**: Matches the existing `src/<module>/` + thin entry point pattern and keeps the logic testable from `test/analysis/`. `parse-session.py` is a self-contained Python script with no test coverage; we want better.
**Trade-offs accepted**: Slightly more module boundaries than a single 700-LOC script. Worth it for testability.

### Decision: Anti-pattern rules as a registry of pure functions
**Chosen approach**: Each rule is a function `(events: SessionEvent[]) => AntiPatternHit[]` registered in `src/analysis/patterns/index.ts`. Rules are pure (no I/O, no shared state) so they unit-test trivially against synthetic event streams.
**Rationale**: New rules added later just append a file; existing rules don't change. Running all rules is just `rules.flatMap(r => r(events))`.
**Trade-offs accepted**: Some rules will share helpers (e.g. "what is the file path argument of this tool call?"). Helpers go in `patterns/util.ts`. No abstract `Rule` class — keep it functions.

### Decision: Initial anti-pattern rule set
1. **`read-twice-no-edit`** — Same file path read N+1 times in a session with no `edit`/`write` to that path between reads. Signals over-reading.
2. **`grep-for-symbol`** — `bash` tool call with a grep/rg pattern that looks like a single identifier (matches `^[A-Za-z_][A-Za-z0-9_]*$` after stripping common regex anchors). Signals `workspace_symbols` was the right call.
3. **`read-after-document-symbols`** — `lsp.document_symbols(F)` followed by `read(F)` covering >50% of the file. Signals targeted read or follow-up `definition` would have sufficed.
4. **`edit-failure-then-reread`** — `edit` toolResult `isError: true` followed by a `read` of the same file before retry. Signals stale-file-error pattern that the AGENTS.md "always read before edit" rule is meant to prevent — except here the stale-file error means the agent's mental model of the file was wrong, often after another tool changed it.
5. **`bash-sed-or-awk-edit`** — `bash` invocation containing `sed -i`, `sed -E -i`, or `awk ... > file` for editing. Signals `edit` tool was the right call.
6. **`read-after-grep-same-file`** — `bash` grep returning matches in file F, followed by `read(F)`. Signals one LSP call (definition, references, document_symbols) would have been more precise.

**Rationale**: These are the patterns the system prompt and AGENTS.md already warn against. Detecting them is a first-pass test of whether the discipline is followed. New rules can be added later as patterns surface.
**Trade-offs accepted**: Each rule has false positives. The report shows raw hits with line refs so the operator can verify before treating a rule as actionable.

### Decision: Outcome correlation via timestamp-window git query
**Chosen approach**: For each session, find commits in `git log --since=<session_start> --until=<session_end + 5min>` whose author email matches `git config user.email`. Then check whether any such commit appears as a "Revert" target in subsequent commits up to `--since 30d` from now.
**Rationale**: Sessions don't directly emit "I committed X" in a structured way (they only show `bash git commit` calls and their stdout). Timestamp+author correlation is approximate but cheap and sufficient for the "did this session land?" question. Revert detection runs the regex `^Revert ".*"` against later commit messages.
**Trade-offs accepted**: Multiple overlapping sessions in the same minute would attribute the same commit to all of them. This is rare and acceptable for a one-off summary tool. If the operator wants exact attribution, they can pass `--session <uuid>` for a single session.

### Decision: Propose-mode prompts with the actual `system-prompt.ts` source attached
**Chosen approach**: Propose mode reads `src/prompt/system-prompt.ts` (whose source includes the verbatim text of the system prompt sections), packages it with the top-20 anti-pattern hits across analyzed sessions, and feeds both to a `createAgentSession` single-turn call (`tools: []`, no system prompt). Output: a markdown section appended to the report.
**Rationale**: The LLM should propose concrete amendments to the actual file the operator would edit. Abstract recommendations are too easy to ignore. Bounded to top-20 hits to keep the prompt under reasonable token budgets.
**Trade-offs accepted**: The propose pass costs a real model call. Behind `--propose` so it's opt-in. Output quality depends on the model — the operator reviews and decides what to keep, like reviewing a junior dev's PR.

### Decision: Output to `.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md`
**Chosen approach**: One report file per invocation, timestamp-suffixed for ordering. Always also print to stdout for in-flow viewing.
**Rationale**: Files-on-disk make diffing across runs trivial (`diff .pi/analyses/2026-05-01*.md .pi/analyses/2026-05-08*.md` shows whether anti-pattern rates moved). `.pi/` already holds project-local config (`.pi/code-intel.json`, `.pi/lsp.json`); analyses fit the same convention.
**Trade-offs accepted**: Disk usage grows over time. The operator can `rm` old reports; we don't auto-prune.

### Decision: Slash command is a prompt template, not a direct script invocation
**Chosen approach**: `/analyze-sessions` is a markdown template that, when expanded, instructs the agent to run `node dist/analysis/cli-main.js $ARGUMENTS` and summarize the resulting report. (Build-then-run; the user is expected to have run `npm run build` already, since pi extensions are loaded from `dist/` anyway.)
**Rationale**: Matches the existing slash-command mechanism (registry sends user messages; templates can't directly exec). Keeps all logic in the script; the slash command is a 5-line wrapper.
**Trade-offs accepted**: One layer of indirection (slash command → user message → agent runs bash → script). For direct use, the operator can invoke the script directly without the slash command.

## Files Introduced

| File | Purpose |
|------|---------|
| `src/analysis/cli-main.ts` | CLI entry point. Parses argv, calls `runAnalysis()`, writes report. Built to `dist/analysis/cli-main.js`. |
| `src/analysis/types.ts` | `SessionEvent`, `SessionMetrics`, `AntiPatternHit`, `OutcomeData`, `AnalysisReport`. |
| `src/analysis/reader.ts` | `readSession(path)` yields typed events; handles compaction boundaries. |
| `src/analysis/metrics.ts` | `extractMetrics(events)` computes summary + efficiency stats. |
| `src/analysis/patterns/index.ts` | Rule registry: imports and exposes the rule functions. |
| `src/analysis/patterns/read-twice-no-edit.ts` | Rule 1. |
| `src/analysis/patterns/grep-for-symbol.ts` | Rule 2. |
| `src/analysis/patterns/read-after-document-symbols.ts` | Rule 3. |
| `src/analysis/patterns/edit-failure-then-reread.ts` | Rule 4. |
| `src/analysis/patterns/bash-sed-or-awk-edit.ts` | Rule 5. |
| `src/analysis/patterns/read-after-grep-same-file.ts` | Rule 6. |
| `src/analysis/patterns/util.ts` | Shared helpers (`getFilePathArg`, `isSymbolPattern`, etc.). |
| `src/analysis/outcomes.ts` | `correlateOutcomes(session, cwd)`: git log query + revert detection. |
| `src/analysis/propose.ts` | `generateProposals(hits, systemPromptSource, model)`: LLM pass. |
| `src/analysis/report.ts` | `renderMarkdown(...)`: composes all five sections. |
| `src/analysis/cli.ts` | `runAnalysis(args)`: orchestration. |
| `src/commands/templates/analyze-sessions.md` | Slash command template. |
| `test/analysis/reader.test.ts` | Reader: well-formed JSONL, malformed lines, compaction handling. |
| `test/analysis/metrics.test.ts` | Metrics: ratios, edit-failure rate, top-tools tabulation. |
| `test/analysis/patterns/*.test.ts` | One test file per rule, synthetic event streams. |
| `test/analysis/outcomes.test.ts` | Stubbed `git log`; correlation logic. |
| `test/analysis/report.test.ts` | Markdown rendering: stable formatting, section ordering, empty-section handling. |
| `test/analysis/propose.test.ts` | Prompt-builder shape; response-parser robustness. (No live LLM call.) |

## Files Modified

| File | Change |
|------|--------|
| `.gitignore` | Add `.pi/analyses/` so generated reports don't get committed. |
| `AGENTS.md` | Document the new `/analyze-sessions` slash command and its purpose. |
| `README.md` | Add a brief section on session analysis under the existing tool list. |

## Known Gaps and Surprises

- **The session JSONL format is documented in `node_modules/@mariozechner/pi-coding-agent/docs/session.md`**, not in our repo. We pin a `^0.62.0` dep; if the upstream format changes incompatibly we will need to update `reader.ts`. We absorb this fragility with version-aware tests (synthetic events match the documented format; real-world session files used to fixture tests are minimized to the fields we read).
- **Anti-pattern rules will produce false positives** — e.g. `read-after-document-symbols` legitimately fires when the agent needs the full file for context, not just a section. The report shows raw hits and line refs precisely so the operator can dismiss false positives manually rather than tuning rule heuristics into mush.
- **Outcome correlation uses author email**, which assumes the operator's git config is consistent across machines. If sessions span machines with different `user.email`, attribution fails silently (commits show as "no commit produced"). Acceptable for v1; can be parameterized later.
- **The propose mode is intentionally non-interactive.** It produces a markdown section the operator reads and acts on by hand. We do not auto-apply, auto-PR, or auto-anything. The proposals are a draft, not a verdict.

## Functional Requirements

- **FR-1**: `runAnalysis(args)` MUST default to scanning `~/.pi/agent/sessions/--<encoded-current-cwd>--/` and accept `--cwd <path>` to override.
- **FR-2**: `--since <duration>` (e.g. `7d`, `24h`) MUST filter sessions by mtime. Default: all sessions in the directory.
- **FR-3**: `--session <uuid>` MUST filter to a single session by UUID prefix match.
- **FR-4**: The report MUST always include sections 1–4 (Summary, Efficiency, Anti-patterns, Outcomes). Section 5 (Propose) is included only when `--propose` is passed.
- **FR-5**: Empty sections MUST render as `(no findings)` rather than be omitted, so a reader can distinguish "we checked and found nothing" from "this section was skipped".
- **FR-6**: Each anti-pattern hit MUST cite `session_id` + JSONL line range so the operator can verify by hand.
- **FR-7**: Outcome correlation MUST report `commit_count`, `last_tool_was_error`, and `reverted_later` per session.
- **FR-8**: The propose-mode LLM call MUST honour the abort signal so a long-running session can be cancelled.
- **FR-9**: The output report MUST be written to `.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md` AND printed to stdout. Directory creation MUST be idempotent.
- **FR-10**: The slash command `/analyze-sessions` MUST forward `$ARGUMENTS` to the script verbatim and instruct the agent to summarize the resulting report.
- **FR-11**: Reader MUST tolerate malformed JSONL lines (skip with a warning to stderr) so a single corrupted line in one session does not abort the whole run.

## Build Sequence

1. **Reader + types** (`src/analysis/types.ts`, `src/analysis/reader.ts`, tests). Foundation; nothing else compiles without it.
2. **Metrics** (`src/analysis/metrics.ts`, tests). Cheap, immediately useful.
3. **Pattern rules** (`src/analysis/patterns/*`, tests). Each rule is a separate file with its own test.
4. **Report renderer** (`src/analysis/report.ts`, tests) + **CLI orchestration** (`src/analysis/cli.ts`) + **CLI shim** (`scripts/analyze-sessions.ts`). At this point `node scripts/analyze-sessions.ts` produces sections 1–3 against real sessions.
5. **Outcomes** (`src/analysis/outcomes.ts`, tests). Adds section 4.
6. **Propose** (`src/analysis/propose.ts`, tests). Adds section 5 behind `--propose`.
7. **Slash command** (`src/commands/templates/analyze-sessions.md`). Template invokes `node dist/analysis/cli-main.js $ARGUMENTS`.
8. **Docs** (`.gitignore`, `AGENTS.md`, `README.md`).

Each phase is independently committable; phases 1–4 deliver a working tool; 5 and 6 extend it.
