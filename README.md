# pi-code-intel

A [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that adds LSP support, sub-agents, and a code intelligence workflow.

## Install

```bash
# From local directory
pi install ./

# Or load directly during development
pi -e ./dist/extension.js
```

## Tools

### `lsp` — Language Server Protocol

Code intelligence via language servers. Supports 34 languages out of the box.

**Actions:**

| Action | Description | Required params |
|--------|-------------|-----------------|
| `definition` | Go to definition | file, line, symbol |
| `type_definition` | Go to type definition | file, line, symbol |
| `implementation` | Find implementations | file, line, symbol |
| `references` | Find all references | file, line, symbol |
| `hover` | Type info and docs | file, line, symbol |
| `diagnostics` | Compiler errors/warnings | file |
| `document_symbols` | List symbols in a file | file |
| `workspace_symbols` | Search symbols across workspace | query, file |
| `incoming_calls` | Find callers of a function | file, line, symbol |
| `outgoing_calls` | Find callees of a function | file, line, symbol |
| `rename` | Rename symbol across codebase | file, line, symbol, new_name |
| `code_actions` | Available fixes/refactors | file, line |
| `status` | Show running LSP servers | — |
| `reload` | Restart all LSP servers | — |

**Supported languages:** TypeScript, Python, Rust, Go, C/C++, Java, Kotlin, Scala, Ruby, PHP, Elixir, Erlang, Haskell, OCaml, Dart, Swift, Zig, Lua, Nix, Gleam, Terraform, and more.

Language servers are auto-discovered. The tool checks `node_modules/.bin/`, `.venv/bin/`, and system PATH.

### `fetch` — Web fetch

Fetch a URL and convert it to markdown for the agent to read. HTML is converted via Turndown (with `script`/`style`/`nav`/`footer`/`header`/`aside`/`iframe`/`noscript` stripped); JSON is pretty-printed; plain text is returned as-is. Large content (> 30K chars) is summarized via a single-turn no-tools agent session focused on the user's prompt.

**Parameters:** `url`, `prompt` (what to extract from the page).

**Hardening:**
- SSRF guard rejects loopback, RFC 1918, link-local (incl. cloud-metadata `169.254.169.254`), and IPv6 unique-local addresses, including hostnames that DNS-resolve into those ranges.
- Redirects are followed manually (`redirect: "manual"`) with the SSRF guard re-run on every hop, capped at 10 redirects.
- Response body is streamed with a 10MB cap enforced per-chunk; oversized bodies abort mid-stream.
- 15-second fetch timeout, 15-minute / 50-entry cache (FIFO eviction).

### `context7` — Library documentation lookup

Look up version-specific library documentation via the [Context7](https://github.com/upstash/context7-mcp) MCP server. Resolves a library/package name (e.g. `express`, `react`, `vitest`) to a Context7-compatible ID, then queries that library's docs for a specific topic.

**Parameters:** `library`, `topic`.

The MCP server is spawned lazily as `npx -y @upstash/context7-mcp` on first call and reused for the lifetime of the session. Internal request frames are capped at 10MB to bound the blast radius of a compromised package.

### `agent` — Sub-agents

Delegate tasks to specialized agents that run independently and return results.

**Available agent types:**

| Type | Model | Description |
|------|-------|-------------|
| `feature-dev:code-architect` | opus | Design feature architectures and implementation blueprints |
| `feature-dev:code-explorer` | sonnet | Deep codebase analysis, trace execution paths |
| `feature-dev:code-reviewer` | opus | Review for bugs, security, quality, conventions |
| `pr-review-toolkit:code-reviewer` | opus | Thorough PR review with priority ratings |
| `pr-review-toolkit:code-simplifier` | opus | Simplify code while preserving functionality |
| `pr-review-toolkit:comment-analyzer` | inherit | Analyze comments for accuracy and staleness |
| `pr-review-toolkit:pr-test-analyzer` | inherit | Review test coverage and identify gaps |
| `pr-review-toolkit:silent-failure-hunter` | opus | Find silent failures and error handling gaps |
| `pr-review-toolkit:type-design-analyzer` | inherit | Analyze type design quality and invariants |
| `pr-review-toolkit:intent-reviewer` | opus | Validate code changes against intent documents |

Sub-agents run in-process via `createAgentSession`. Sessions persist to disk under `subagents/` when a parent session dir is available. "inherit" agents use the parent's current model.

Sub-agents have a default 15-minute timeout (raised from an earlier 5min that empirically killed productive review-heavy runs). The caller LLM can override per-invocation via the optional `timeoutMs` parameter, bounded `[30000, 1800000]` (30s–30min). When a timeout fires, any partial output is still returned alongside a `timedOut` error.

Sub-agent templates declare a `tools` allowlist in their frontmatter. The parent's `lsp`, `fetch`, and `context7` tools are made available to any sub-agent whose template explicitly lists them; tools not listed are filtered out.

## Code Intelligence Workflow

The extension injects a tool selection hierarchy into the system prompt that guides the LLM to use LSP before falling back to grep/find:

| Goal | Wrong first choice | Right first choice |
|------|-------------------|-------------------|
| Find where a symbol is defined | grep (name search) | `lsp definition` |
| Find where a symbol is used | grep (name search) | `lsp references` |
| Find who calls a function | grep (name search) | `lsp incoming_calls` |
| What does a function call? | read (manual) | `lsp outgoing_calls` |
| Understand a file's structure | read (entire file) | `lsp document_symbols` |

## Format-on-Write

After every `edit` or `write` tool call, the modified file is automatically synced with the LSP server. This keeps diagnostics up-to-date without requiring manual checks.

## Configuration

Create `.pi/code-intel.json` in your project root (or `~/.pi/agent/code-intel.json` for global config):

```json
{
  "lsp": { "enabled": true },
  "agents": { "enabled": true },
  "prompt": { "enabled": true },
  "web": { "enabled": true },
  "context7": { "enabled": true }
}
```

### LSP Server Overrides

Create `.pi/lsp.json` to override or add language server configs:

```json
{
  "typescript-language-server": {
    "command": "/custom/path/to/typescript-language-server",
    "args": ["--stdio"]
  },
  "my-custom-server": {
    "command": "my-lsp",
    "args": ["--stdio"],
    "fileTypes": [".mycustom"],
    "rootMarkers": ["my.config.json"]
  }
}
```

## Development

```bash
npm install
npm run build     # Compile + copy assets
npm run typecheck  # Type check without emitting
npm test          # Run tests
npm run dev       # Watch mode
```

## Architecture

```
src/
├── extension.ts          # Entry point — registers all tools and hooks
├── config.ts             # Project config loading (.pi/code-intel.json)
├── types.ts              # Shared `AnyModel = Model<any>` alias
├── lsp/
│   ├── client.ts         # LSP client manager (JSON-RPC over stdio)
│   ├── config.ts         # Server auto-discovery and config merging
│   ├── defaults.json     # 34 language server configurations
│   ├── tool.ts           # LSP tool definition
│   ├── types.ts          # LSP protocol types
│   └── utils.ts          # Formatters for locations, diagnostics, symbols
├── web/
│   ├── fetch.ts          # SSRF guard, redirect loop, cache, HTML→markdown
│   ├── tool.ts           # `fetch` tool definition
│   ├── summarizer.ts     # Single-turn no-tools agent session for large content
│   └── context7.ts       # Context7 MCP stdio client + `context7` tool
├── agents/
│   ├── runner.ts         # Sub-agent execution + timeout + progress streaming
│   ├── templates.ts      # Template parsing and registry
│   ├── tool.ts           # Agent tool definition
│   └── templates/        # Agent markdown templates
├── prompt/
│   ├── code-exploration.ts  # LSP-focused code exploration guidance
│   └── system-prompt.ts     # Code intelligence workflow prompt
└── analysis/
    ├── capture.ts            # `before_agent_start` hook that persists rendered system prompt
    ├── cli.ts                # CLI orchestration
    ├── cli-main.ts           # Executable entry point (built to dist/analysis/cli-main.js)
    ├── reader.ts             # Session JSONL parser → typed AnalysisEvent stream
    ├── metrics.ts            # Per-session and aggregated metrics
    ├── patterns/             # Anti-pattern rule registry (one rule per file)
    ├── outcomes.ts           # Git-correlation: commits-in-window, revert detection
    ├── propose.ts            # LLM-driven prompt-amendment proposals
    ├── report.ts             # Markdown renderer
    └── types.ts              # AnalysisEvent + AntiPatternHit + ParsedSession
```

## License

MIT
