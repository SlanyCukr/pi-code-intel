# pi-code-intel — Agent Guidelines

## Project Overview

Pi extension package that adds LSP support, sub-agents, and a code intelligence workflow to the pi coding agent. Built as a standard pi package using TypeScript.

## Build & Test

```bash
npm run build      # Compile TypeScript + copy assets (defaults.json, templates)
npm run typecheck   # Type check without emitting
npm test           # Run vitest tests
npm run dev        # Watch mode for TypeScript compilation
```

Always run `npm run build && npm test` before considering any change complete.

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

### Sub-agents
Created via `createAgentSession()` in `src/agents/runner.ts`. Sessions persist to disk under `<parent-session-dir>/subagents/` when a parent session dir is available, otherwise fall back to `SessionManager.inMemory()`. Call `session.agent.setSystemPrompt()` to set the prompt, `session.prompt(task)` to run, `session.dispose()` to clean up. Subagent JSONL files use the same format as main sessions — see `node_modules/@mariozechner/pi-coding-agent/docs/session.md` for the full spec.

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
extension.ts → config.ts, lsp/*, agents/*, commands/*, prompt/*, rtk.ts
agents/tool.ts → agents/runner.ts, agents/templates.ts
agents/runner.ts → agents/templates.ts, prompt/code-exploration.ts, prompt/subagent-prompt.ts, rtk.ts
agents/templates.ts → utils/frontmatter.ts, utils/templates.ts
commands/registry.ts → agents/templates.ts, utils/frontmatter.ts, utils/templates.ts
lsp/tool.ts → lsp/client.ts → lsp/config.ts, lsp/utils.ts, lsp/types.ts
```

No circular dependencies. `lsp/`, `prompt/`, and `utils/` are independent leaf modules. `agents/templates.ts` is the template registry (parse, load, query). `agents/runner.ts` handles sub-agent execution. `commands/` depends on `agents/templates.ts` (for template grouping). `extension.ts` is the hub that wires everything together.

## Conventions

- ES modules with `.js` extensions in imports (even for `.ts` sources)
- `@sinclair/typebox` for tool parameter schemas
- Use `Model<any>` (not `Model<unknown>`) for pi SDK model types
- Assets (defaults.json, templates) copied to `dist/` by `scripts/copy-assets.ts`
- Config files at `.pi/code-intel.json` (project) and `.pi/lsp.json` (LSP overrides)
- All bash commands routed through RTK for token-optimized output — no dedicated grep/find/ls tools
- Dependency: `@mariozechner/pi-coding-agent ^0.62.0`
