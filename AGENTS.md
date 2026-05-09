# pi-code-intel — Agent Guidelines

## Project Overview

Pi extension package that adds LSP support, sub-agents, web fetch, Context7 library lookup, and a code intelligence workflow to the pi coding agent. Built as a standard pi package using TypeScript.

## Build & Test

```bash
npm run build       # Compile TypeScript + copy assets (defaults.json, templates, parse-session.py, system-prompt.source.ts)
npm run typecheck   # Type check without emitting
npm test            # Run vitest tests (fast; ~2s for 507 tests)
npm run dev         # Watch mode for TypeScript compilation

# Slower integration tests (NOT in `npm test`):
npm run smoke         # Real Context7 MCP smoke test against `npx -y @upstash/context7-mcp@^2.2.4`. ~30-60s first run (npx download), ~5-10s warm. Network required.
npm run test:foreign  # `npm pack` + install into temp project + run analyzer from installed location. Catches packaging bugs (missing files, broken peerDeps, dist-not-shipped). ~30-60s.
```

Always run `npm run build && npm test` before considering any change complete. For changes that touch the Context7 client, the analyzer's published surface, or the `package.json#files` allowlist, also run `npm run smoke` and `npm run test:foreign`.

### CI

`.github/workflows/ci.yml` runs three jobs in parallel on every push to `main` and every PR:

- **`unit`**: typecheck + build + `npm test`. Required for merge. Installs `rtk@v0.39.0` because `test/rtk.test.ts` exercises the real binary.
- **`foreign-install`**: runs `npm run test:foreign`. Required for merge.
- **`mcp-smoke`**: runs `npm run smoke`. `continue-on-error: true` because it depends on the upstream Context7 service being reachable; treat failures as a signal to investigate, not as a merge blocker.

## Issue handling

If you discover an issue while working on something else — stale docs, broken comments, mislabeled types, dead code, a bug adjacent to your change, a doc that contradicts the code, anything — you MUST address it in the same session. Choose one of:

1. **Fix it now.** A small extra commit is fine and preferred for rot.
2. **Surface it to your partner and pause** until they decide.

You MUST NOT use any of these escape hatches:
- "pre-existing"
- "out of scope"
- "for a follow-up commit"
- "noted in known gaps" / "flagged for later"
- "documented for later" / "TODO for the next session"
- any equivalent label that lets the issue survive into the next session

These labels are how rot accumulates. The only honest options are *fix* or *escalate*. The pattern "I'll note this and continue with my main task" is banned. Logging a finding to a TODO is not a fix.

When in doubt, fix it. The cost of one small unnecessary commit is far smaller than the cost of an issue surviving to ten sessions from now.

## Test discipline

Unit tests with stubbed I/O verify your logic, not your deployment. Bugs that survive happy-path coverage live at integration boundaries your fixtures hide. "It compiles, unit tests pass, end-to-end runs once locally" is NOT proof of completeness — that pattern shipped 8 real bugs across 3 codex rounds during the analyze-sessions feature, all in code where the unit tests passed cleanly.

Before declaring a feature complete, you MUST exercise it under at least these conditions:

- **A different cwd.** Subdirectory of a repo, relative paths (`.`, `..`, `../proj`), non-existent paths, paths that contain no `.git`. Most path-resolution bugs hide here.
- **A different install location.** If the feature ships `dist/`, run it from a project where only `dist/` is reachable — nothing in `src/` or `scripts/` is. Anything derived from the user's `cwd` rather than the extension's install path will be wrong.
- **Adjacent SDK events you didn't hook.** If you hook `event_a`, list `event_b`/`event_c`/etc. (e.g. `session_switch` AND `session_fork` AND `session_compact` AND `session_tree`) and decide whether each needs the same handling. Skipping one is a silent bug — captures, dedupe, cleanup all break for the unhooked path.
- **Documented failure modes.** Every "throws if X" or "returns null when Y" in the SDK deserves a test that triggers X / Y. If the SDK distinguishes states (e.g. error vs empty vs missing), exercise each.
- **Real binary I/O when the boundary uses one.** Stdio framing, file-format parsing, MCP protocols — a mock that parrots the wrong protocol passes its own tests. At least one test or one local end-to-end run MUST go through the real implementation.

When you're tempted to call it done, ask: which boundary do my fixtures hide? Then test what they hide. Do not claim completion until that question has an answer.

## Key Patterns

### Tool Definitions
Tools use `ToolDefinition<TParams>` from `@mariozechner/pi-coding-agent` with TypeBox schemas. The `execute` function has 5 parameters: `(toolCallId, params, signal, onUpdate, ctx)`. Signal errors by throwing — the agent-core sets `isError: true` on caught exceptions. Return `{ content: [...], details: undefined }`.

### Extension Entry Point
`src/extension.ts` exports a function matching `ExtensionFactory` — `(pi: ExtensionAPI) => void`. Register tools with `pi.registerTool()`, hook events with `pi.on()`.

### Agent Templates
Markdown files in `src/agents/templates/<category>/<name>.md` with YAML-like frontmatter:
```
---
name: template-name
category: category-name
description: One-line description
model: sonnet | opus | inherit
thinkingLevel: off | minimal | low | medium | high | xhigh
tools: [read, bash, lsp]
---
# System prompt content here
```

### LSP Client
`src/lsp/client.ts` uses binary `Buffer` for message framing (Content-Length headers are byte counts). Never use string length for LSP message slicing.

### Web fetch (`src/web/fetch.ts`)
SSRF guard checks both literal IPs and DNS-resolved addresses against loopback / RFC1918 / link-local / IPv6 unique-local. Redirects are followed manually with the SSRF guard re-run on every hop (capped at 10 hops; non-HTTP(S) `Location` schemes refused). Response body is streamed and the 10MB cap is enforced per-chunk. The external abort signal listener attaches before the early SSRF DNS lookup so cancellations propagate cleanly through the entire pipeline.

### Context7 MCP client (`src/web/context7.ts`)
Lightweight stdio JSON-RPC client. MCP stdio framing is **newline-delimited JSON** (one message per line) — NOT LSP-style `Content-Length` framing. JSON.stringify never emits raw newlines, so a single trailing `\n` is sufficient on the wire. Buffer is binary so `\n` indexing is byte-correct under multi-byte UTF-8.

The Context7 server's tool surface evolved since the original integration: `resolve-library-id` requires both `libraryName` (matching) and `query` (ranking); the docs tool was renamed `query-docs` (was `get-library-docs`) and takes `libraryId` + `query`. `resolveLibrary` therefore takes a query parameter so the topic flows through to ranking.

The MCP server version is pinned via the `CONTEXT7_MCP_VERSION` constant (currently `^2.2.4`). An unpinned `npx -y @upstash/context7-mcp` would silently pull whatever ships next — a breaking tool-rename in any future minor would take this extension dark with no warning. The MCP smoke test in CI is responsible for catching drift within the accepted range; if it fails, tighten the pin in `src/web/context7.ts`.

Process event handlers (`data`, `error`, `exit`) are identity-guarded against the spawned `ChildProcess`: a late event from a previously-killed process must be a no-op for the new one. Per-line cap is 10MB — a server that streams gigabytes without ever emitting a newline triggers `stop()`. Tool calls that return `isError: true` throw rather than silently treating the error message as data.

### Summarizer (`src/web/summarizer.ts`)
Content ≤ 30K chars passes through; larger content goes through a single-turn `createAgentSession` with `tools: []` and an empty system prompt. Check `signal?.aborted` both before AND after `createAgentSession` resolves (`EventTarget` does not replay past abort events). The abort handler must wrap `session.abort()` in `.catch(() => {})` because Node's default `--unhandled-rejections=throw` turns a fire-and-forget rejection into a process crash.

### Sub-agents
Created via `createAgentSession()` in `src/agents/runner.ts`. Sessions persist to disk under `<parent-session-dir>/subagents/` when a parent session dir is available, otherwise fall back to `SessionManager.inMemory()`. Call `session.agent.setSystemPrompt()` to set the prompt, `session.prompt(task)` to run, `session.dispose()` to clean up. Subagent JSONL files use the same format as main sessions — see `node_modules/@mariozechner/pi-coding-agent/docs/session.md` for the full spec.

Sub-agent timeout: `runSubAgent` defaults to 15 minutes; pass `timeout` (ms; `0` disables) to override. The `agent` tool exposes this to the calling LLM as `timeoutMs`, schema-bounded `[30000, 1800000]`. On timeout the session is aborted but partial output is still returned alongside an `error` field describing the timeout.

Progress streaming: `runSubAgent` forwards three event types from the inner `AgentSession` to its `onProgress` callback — `tool_execution_start`, `tool_execution_end`, and `message_update` (assistant text preview, truncated to 120 chars).

Tool inheritance: parent-owned tools (`lsp`, `fetch`, `context7`) are passed to sub-agent sessions via `customTools`. Each sub-agent template's frontmatter `tools:` allowlist filters this set by name — a tool only becomes available when the template explicitly lists it.

### Session Format
Pi sessions are JSONL files at `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`. Each line is a JSON object with a `type` field. Key entry types:
- `session` — header with version, uuid, cwd
- `message` — contains `AgentMessage` with role `user`, `assistant`, or `toolResult`
- `model_change`, `thinking_level_change` — mid-session switches
- `compaction` — context compaction summaries

Assistant messages contain `toolCall` content blocks: `{ type: "toolCall", name: string, arguments: Record<string, any> }`. Tool results are separate `toolResult` messages with `toolName`, `content`, `isError`.

Use `/read-session <path>` to parse and summarize a session file (runs `scripts/parse-session.py`).

### Session analysis (`src/analysis/`)

A one-off CLI for retrospective analysis of past sessions:

```bash
npm run build
node dist/analysis/cli-main.js [--cwd PATH] [--since 7d]
                               [--session UUID] [--out PATH]
                               [--no-write] [--propose]
```

Or in-flow: `/analyze-sessions [args]`.

Produces a markdown report at `.pi/analyses/<YYYY-MM-DD>_<HHMMSS>.md` with five sections: Summary (1), Efficiency ratios (2), Anti-pattern hits (3), Outcomes via git correlation (4), and — only when `--propose` is passed — LLM-driven prompt-amendment proposals (5).

**System-prompt capture**: the extension records the rendered system prompt to the session JSONL on every `before_agent_start` whose hash differs from the last capture (via `pi.appendEntry("code-intel:system-prompt", ...)`). The dedupe hash is reset on `session_switch` (covers `/new` and `/resume`) AND `session_fork` — both create new JSONL files that need their own capture. `session_compact` and `session_tree` stay in the same file and intentionally do NOT reset (see capture.ts for the analysis). This grounds propose mode in what the agent actually saw at session time. Disable via `analysis: { captureSystemPrompt: false }` in `.pi/code-intel.json`.

Sessions recorded before this hook existed fall back to a system-prompt source. The fallback search order (`resolveSystemPromptFallback` in cli.ts):
1. `<dist>/prompt/system-prompt.source.ts` — shipped via copy-assets.ts. Always available when the extension is installed normally.
2. `<analyzed-cwd>/src/prompt/system-prompt.ts` — only when the operator is analyzing this very repo's checkout. Kept as a secondary path so dev iteration still works against fresh source even when dist is stale.

When the fallback is used, proposals are labeled forward-looking in the report footer.

**Session-directory encoding**: `encodeSessionDirName(cwd)` in cli.ts mirrors the SDK's `getDefaultSessionDir` byte-for-byte: `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`. Strips one leading slash/backslash, then replaces remaining slashes, backslashes, and colons with `-`. Colons matter on Windows (`C:\...`) and on Unix paths containing colons. If pi ever changes its encoding, this is the single place that must be updated.

## Module Dependencies

```
extension.ts → config.ts, lsp/*, web/*, agents/*, commands/*, prompt/*, analysis/capture.ts, rtk.ts
agents/tool.ts → agents/runner.ts, agents/templates.ts
agents/runner.ts → agents/templates.ts, prompt/code-exploration.ts, rtk.ts, types.ts, utils/agent-messages.ts
agents/templates.ts → utils/frontmatter.ts, utils/templates.ts
analysis/cli-main.ts → analysis/cli.ts → analysis/{reader, metrics, patterns/*, outcomes, propose, report}.ts
analysis/cli.ts → @mariozechner/pi-coding-agent (getAgentDir for $PI_CODING_AGENT_DIR)
analysis/capture.ts (self-contained pi hook + customType constant; consumed by reader.ts)
analysis/propose.ts → types.ts (AnyModel) + isolated-session.ts + utils/agent-messages.ts
isolated-session.ts (single boundary for one-off LLM calls; consumed by propose.ts and web/summarizer.ts)
commands/registry.ts → agents/templates.ts, utils/frontmatter.ts, utils/templates.ts (exposes $EXTENSION_DIST substitution)
lsp/tool.ts → lsp/client.ts → lsp/config.ts, lsp/utils.ts, lsp/types.ts
web/tool.ts → web/fetch.ts, web/summarizer.ts
web/summarizer.ts → types.ts, isolated-session.ts, utils/agent-messages.ts
web/context7.ts (self-contained MCP client + tool definition; CONTEXT7_MCP_VERSION pin)
```

No circular dependencies. `lsp/`, `web/`, `prompt/`, and `utils/` are independent leaf modules (with `web/summarizer.ts`, `agents/runner.ts`, and `analysis/propose.ts` sharing the `types.ts` `AnyModel` alias). `agents/templates.ts` is the template registry (parse, load, query). `agents/runner.ts` handles sub-agent execution. `analysis/` is a self-contained subsystem with its own CLI entry; `analysis/capture.ts` is the only file `extension.ts` reaches into directly. `commands/` depends on `agents/templates.ts` (for template grouping). `extension.ts` is the hub that wires everything together.

## Conventions

- ES modules with `.js` extensions in imports (even for `.ts` sources)
- `@sinclair/typebox` for tool parameter schemas
- Use `Model<any>` (not `Model<unknown>`) for pi SDK model types
- Assets copied to `dist/` by `scripts/copy-assets.ts`: `defaults.json`, agent + command templates, `scripts/parse-session.py` (for `read-session` slash command), and `prompt/system-prompt.source.ts` (for propose-mode fallback grounding when no captures exist)
- Slash command templates in `src/commands/templates/*.md` may use `$EXTENSION_DIST` to reference the extension's compiled `dist/` directory; `commands/registry.ts` substitutes the absolute path at command-expansion time. Always shell-quote the substituted path so install paths with spaces still work.
- `package.json#files` is an explicit allowlist (`dist/`, `README.md`, `LICENSE`); without it npm pack would gitignore-exclude `dist/` and ship a broken package. The foreign-install test pins this contract.
- Config files at `.pi/code-intel.json` (project) and `.pi/lsp.json` (LSP overrides). Sections: `lsp`, `agents`, `prompt`, `web`, `context7` — each with `enabled: boolean`. Plus `analysis: { captureSystemPrompt: boolean }` for the session-analysis tooling.
- All bash commands routed through RTK for token-optimized output — no dedicated grep/find/ls tools. The `rtkSpawnHook` tolerates exit codes other than 0/1 when stdout has content (rtk 0.39+ emits a deprecation warning with exit 3 alongside valid output).
- Pinned external binaries: `@upstash/context7-mcp@^2.2.4` (in `src/web/context7.ts`), `rtk@v0.39.0` (in `.github/workflows/ci.yml`). Both protected by integration tests.
- Dependency: `@mariozechner/pi-coding-agent ^0.62.0`
