# pi-code-intel — Agent Guidelines

## Project Overview

Pi extension package that adds LSP support, sub-agents, web fetch, Context7 library lookup, and a code intelligence workflow to the pi coding agent. Built as a standard pi package using TypeScript.

## Build & Test

```bash
npm run build      # Compile TypeScript + copy assets (defaults.json, templates)
npm run typecheck   # Type check without emitting
npm test           # Run vitest tests
npm run dev        # Watch mode for TypeScript compilation
```

Always run `npm run build && npm test` before considering any change complete.

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

## Module Dependencies

```
extension.ts → config.ts, lsp/*, web/*, agents/*, commands/*, prompt/*, rtk.ts
agents/tool.ts → agents/runner.ts, agents/templates.ts
agents/runner.ts → agents/templates.ts, prompt/code-exploration.ts, lsp/tool.ts, rtk.ts, types.ts
agents/templates.ts → utils/frontmatter.ts, utils/templates.ts
commands/registry.ts → agents/templates.ts, utils/frontmatter.ts, utils/templates.ts
lsp/tool.ts → lsp/client.ts → lsp/config.ts, lsp/utils.ts, lsp/types.ts
web/tool.ts → web/fetch.ts, web/summarizer.ts
web/summarizer.ts → types.ts
web/context7.ts (self-contained MCP client + tool definition)
```

No circular dependencies. `lsp/`, `web/`, `prompt/`, and `utils/` are independent leaf modules (with `web/summarizer.ts` and `agents/runner.ts` sharing the `types.ts` `AnyModel` alias). `agents/templates.ts` is the template registry (parse, load, query). `agents/runner.ts` handles sub-agent execution. `commands/` depends on `agents/templates.ts` (for template grouping). `extension.ts` is the hub that wires everything together.

## Conventions

- ES modules with `.js` extensions in imports (even for `.ts` sources)
- `@sinclair/typebox` for tool parameter schemas
- Use `Model<any>` (not `Model<unknown>`) for pi SDK model types
- Assets (defaults.json, templates) copied to `dist/` by `scripts/copy-assets.ts`
- Config files at `.pi/code-intel.json` (project) and `.pi/lsp.json` (LSP overrides). Sections: `lsp`, `agents`, `prompt`, `web`, `context7` — each with `enabled: boolean`.
- All bash commands routed through RTK for token-optimized output — no dedicated grep/find/ls tools
- Dependency: `@mariozechner/pi-coding-agent ^0.62.0`
