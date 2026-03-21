# pi-code-intel — Agent Guidelines

## Project Overview

Pi extension package that adds LSP, sub-agents, semantic search, and code intelligence to the pi coding agent. Built as a standard pi package using TypeScript.

## Build & Test

```bash
npm run build      # Compile TypeScript + copy assets (defaults.json, templates)
npm run typecheck   # Type check without emitting
npm test           # Run vitest tests (61 tests)
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
tools: [read, grep, find, ls, lsp, search_code]
---
# System prompt content here
```

### LSP Client
`src/lsp/client.ts` uses binary `Buffer` for message framing (Content-Length headers are byte counts). Never use string length for LSP message slicing.

### Sub-agents
Created via `createAgentSession()` with `SessionManager.inMemory()`. Call `session.agent.setSystemPrompt()` to set the prompt, `session.prompt(task)` to run, `session.dispose()` to clean up.

## Module Dependencies

```
extension.ts → config.ts, lsp/*, agents/*, search/*, prompt/*
agents/tool.ts → agents/runner.ts → @mariozechner/pi-coding-agent SDK
lsp/tool.ts → lsp/client.ts → lsp/config.ts, lsp/utils.ts, lsp/types.ts
search/tool.ts → search/process.ts → search/client.ts
```

No circular dependencies. `lsp/`, `agents/`, `search/`, and `prompt/` are independent modules — only `extension.ts` wires them together.

## Conventions

- ES modules with `.js` extensions in imports (even for `.ts` sources)
- `@sinclair/typebox` for tool parameter schemas
- Use `Model<any>` (not `Model<unknown>`) for pi SDK model types
- Assets (defaults.json, templates) copied to `dist/` by `scripts/copy-assets.ts`
- Config files at `.pi/code-intel.json` (project) and `.pi/lsp.json` (LSP overrides)
