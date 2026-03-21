# pi-code-intel

A [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that adds LSP support, sub-agents, semantic code search, and a code intelligence workflow.

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

### `search_code` — Semantic Code Search

Search the codebase by meaning, not just text patterns. Powered by [semvex](https://github.com/your/semvex-mcp).

```
search_code({ query: "authentication middleware" })
search_code({ query: "database connection pooling", language: "python" })
```

Requires semvex-mcp running with vLLM and Qdrant backends. Falls back gracefully when unavailable.

### `search_docs` — Documentation Search

Search project documentation (README, guides, API docs) semantically.

```
search_docs({ query: "how to configure the build" })
```

### `agent` — Sub-agents

Delegate tasks to specialized agents that run independently and return results.

**Available agent types:**

| Type | Model | Description |
|------|-------|-------------|
| `feature-dev:code-architect` | sonnet | Design feature architectures and implementation blueprints |
| `feature-dev:code-explorer` | sonnet | Deep codebase analysis, trace execution paths |
| `feature-dev:code-reviewer` | sonnet | Review for bugs, security, quality, conventions |
| `lsp-agents:lsp-explore` | inherit | Explore codebase using LSP and semantic search |
| `lsp-agents:lsp-plan` | inherit | Design implementation plans using LSP exploration |
| `pr-review-toolkit:code-reviewer` | opus | Thorough PR review with priority ratings |
| `pr-review-toolkit:code-simplifier` | opus | Simplify code while preserving functionality |
| `pr-review-toolkit:comment-analyzer` | inherit | Analyze comments for accuracy and staleness |
| `pr-review-toolkit:pr-test-analyzer` | inherit | Review test coverage and identify gaps |
| `pr-review-toolkit:silent-failure-hunter` | inherit | Find silent failures and error handling gaps |
| `pr-review-toolkit:type-design-analyzer` | inherit | Analyze type design quality and invariants |

Sub-agents run in-process via `createAgentSession` with `SessionManager.inMemory()`. "inherit" agents use the parent's current model.

## Code Intelligence Workflow

The extension injects a tool selection hierarchy into the system prompt that guides the LLM to use LSP and semantic search before falling back to grep/find:

| Goal | Wrong first choice | Right first choice |
|------|-------------------|-------------------|
| Find code related to a concept | grep (keyword guessing) | `search_code` |
| Find where a symbol is defined | grep (name search) | `lsp definition` |
| Find where a symbol is used | grep (name search) | `lsp references` |
| Find who calls a function | grep (name search) | `lsp incoming_calls` |
| What does a function call? | read (manual) | `lsp outgoing_calls` |
| Understand a file's structure | read (entire file) | `lsp document_symbols` |
| Find project docs | grep (keyword search) | `search_docs` |

## Format-on-Write

After every `edit` or `write` tool call, the modified file is automatically synced with the LSP server. This keeps diagnostics up-to-date without requiring manual checks.

## Configuration

Create `.pi/code-intel.json` in your project root (or `~/.pi/agent/code-intel.json` for global config):

```json
{
  "lsp": {
    "enabled": true
  },
  "search": {
    "enabled": true,
    "command": "semvex-mcp"
  },
  "agents": {
    "enabled": true
  },
  "prompt": {
    "enabled": true
  }
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
├── lsp/
│   ├── client.ts         # LSP client manager (JSON-RPC over stdio)
│   ├── config.ts         # Server auto-discovery and config merging
│   ├── defaults.json     # 34 language server configurations
│   ├── tool.ts           # LSP tool definition
│   ├── types.ts          # LSP protocol types
│   └── utils.ts          # Formatters for locations, diagnostics, symbols
├── agents/
│   ├── runner.ts         # Template loading, sub-agent execution via SDK
│   ├── tool.ts           # Agent tool definition
│   └── templates/        # 11 agent markdown templates
├── search/
│   ├── client.ts         # MCP JSON-RPC client
│   ├── process.ts        # Semvex subprocess lifecycle
│   └── tool.ts           # search_code + search_docs tools
└── prompt/
    └── system-prompt.ts  # Code intelligence workflow prompt
```

## License

MIT
