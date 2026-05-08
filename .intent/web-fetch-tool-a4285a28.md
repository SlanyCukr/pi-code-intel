# Intent: Web fetch tool with HTML→markdown and content summarization

**Created**: 2026-05-07 (retroactive — code was written earlier, this doc is reverse-engineered)
**ID**: web-fetch-tool-a4285a28

---

## Problem Statement

Coding agents need a way to read web pages — library docs, API references, release notes, error-message lookups. Without one, the agent has to either guess from training data (often stale) or ask the user to paste the page in. The fetch tool gives the agent a typed, signal-aware way to retrieve a URL, render it to markdown, and condense it into the slice the prompt actually asked for.

This intent doc covers the first commit of a multi-commit reorganization of pre-existing uncommitted work. The code already exists in the working tree; this doc records intent retroactively so future readers can review the feature as a coherent unit.

## Scope

**In scope:**
- A `fetch` tool registered on the pi extension API: `(url, prompt) → markdown`.
- HTML→markdown conversion via `turndown` with non-content elements (`script`, `style`, `nav`, `footer`, `header`, `aside`, `iframe`, `noscript`) stripped.
- Content-type-aware handling: HTML → markdown, JSON → pretty-printed, other text → as-is.
- A 15-minute TTL cache keyed on URL, with FIFO eviction past 50 entries.
- A 15-second fetch timeout and 10MB response cap.
- An SSRF guard that rejects loopback, RFC1918, link-local (incl. cloud-metadata 169.254.169.254), and IPv6 unique-local addresses, including hostnames that DNS-resolve into those ranges.
- Streaming body-size enforcement: cumulative byte count is checked per chunk so an oversized body is aborted before it is fully buffered.
- A summarizer that returns small content (≤30K chars) directly and uses a single-turn agent session (no tools) for larger content, so the agent only sees the relevant slice.
- Tests for: HTML conversion, JSON formatting, truncation, caching, error paths, AbortError handling, content-length and streaming size limits, and the full SSRF matrix (literal IPs, IPv4-mapped IPv6, multi-A-record bypass, DNS lookup failure surface).
- A new shared type alias `AnyModel` extracted to `src/types.ts` so summarizer (and later runner) can share the `Model<any>` shape used across pi-coding-agent.

**Out of scope:**
- The Context7 MCP integration (sibling feature — has its own commit and is documented as a peer, not a dependency).

*(All other items originally listed here — tool registration in `src/extension.ts`, `web` config section in `src/config.ts`, and system-prompt guidance in `src/prompt/system-prompt.ts` — were delivered in the same multi-commit reorganization that this doc retroactively records, and are now in the codebase.)*

## Architectural Decisions

### Decision: Single-file `fetch.ts` for SSRF + HTTP + cache + content classification
**Chosen approach**: Keep `assertSafeUrl`, the SSRF blocklist helpers, the cache, and `fetchUrl` in one module. Export `htmlToMarkdown` and `clearCache` for tests.
**Rationale**: All of these are tightly coupled — any callsite that wants the safe `fetchUrl` wants the SSRF guard and the size enforcement, with no toggles. Splitting would invite a "raw fetch" import path that bypasses the guard.
**Trade-offs accepted**: ~300 lines in one file. Acceptable: the file does one thing (safely fetch a URL).

### Decision: SSRF guard via dual-pass (literal IP check + DNS resolve)
**Chosen approach**: Parse `URL.hostname`. If `node:net.isIP` says it's a literal, check it directly. Otherwise resolve via `dns.lookup(host, { all: true })` and reject if any returned address is private. Strip surrounding `[]` from IPv6 literals before checking.
**Rationale**: Catches both `http://127.0.0.1` and `http://localtest.me` without a third-party library. Multi-A-record bypass is closed by checking every resolved address, not just the first.
**Trade-offs accepted**: One DNS round-trip per fetch (cached by the OS resolver). TOCTOU between `dns.lookup` and the actual `fetch` is theoretical and out of threat model — the threat is an LLM-controlled URL, not a hostile DNS responder.

### Decision: Stream `response.body` chunk-by-chunk with cumulative byte tracking
**Chosen approach**: `for await (const chunk of response.body)`, push to a `Buffer[]`, abort the controller and throw the moment cumulative bytes exceed `MAX_RESPONSE_BYTES`. Decode UTF-8 once at the end.
**Rationale**: A `Content-Length` check is advisory — many servers omit the header or lie. Streaming enforcement is the only way to guarantee the byte limit.
**Trade-offs accepted**: A small amount of extra code vs `response.text()`. Worth it for the actual guarantee.

### Decision: Summarizer uses a single-turn no-tools agent session
**Chosen approach**: For content > 30K chars, spin up an agent session with `tools: []` and an empty system prompt; feed it `Web page content:\n---\n<content>\n---\n\n<userPrompt>\n\nProvide a concise response...`; read the last assistant message's text.
**Rationale**: Reuses the pi-coding-agent infrastructure (model resolution, abort handling, message format) without inventing a new model-call pathway. No tools means no risk of accidental side effects from a summarization run.
**Trade-offs accepted**: Slight overhead vs a direct `model.complete()` call. Worth it for consistency with the rest of the extension.

### Decision: Extract `AnyModel` to `src/types.ts`
**Chosen approach**: A single re-exported type alias that both `summarizer.ts` and (later) `runner.ts` can import from one place.
**Rationale**: The `Model<any>` shape was previously inlined in `runner.ts`. Adding a second consumer (summarizer) was a good moment to deduplicate.
**Trade-offs accepted**: One extra file with three lines. Worth it for the single point of truth.

## Files Introduced

| File | Purpose |
|------|---------|
| `src/web/fetch.ts` | SSRF guard, cache, HTML→markdown, `fetchUrl` entry point. |
| `src/web/tool.ts` | Pi `ToolDefinition` wrapper that wires `fetchUrl` + `summarizeContent` together with onUpdate progress reporting. |
| `src/web/summarizer.ts` | `summarizeContent` — small-content passthrough + agent-session-based extraction for large content. |
| `src/types.ts` | Shared `AnyModel` type alias (`Model<any>` from `@mariozechner/pi-ai`). |
| `test/web/fetch.test.ts` | HTML conversion, JSON formatting, truncation, caching, errors, abort, size limits (header + streaming), full SSRF matrix. |
| `test/web/summarizer.test.ts` | Small/large branches, dispose-on-error, fallback when model produces no output. |
| `test/web/tool.test.ts` | Tool wiring: schema, signal propagation, onUpdate calls, error propagation. |

## Files Modified

| File | Change |
|------|--------|
| `package.json` | Add `turndown` to dependencies, `@types/turndown` to devDependencies. |
| `package-lock.json` | Lock turndown + transitive deps. |

## Known Gaps and Surprises

- ~~**Pre-existing bug in fetch.ts**: the external `signal` listener is attached AFTER `assertSafeUrl(parsed, signal)` returns, so an abort during the DNS phase doesn't propagate cleanly to the subsequent `fetch()` call.~~ **Resolved.** The listener is now attached before the early `assertSafeUrl` call, so an abort fired during DNS — or in the gap between DNS resolving and `fetch()` starting — propagates to `controller.signal`. The cache-hit path now also clears the timeout before returning so the listener wrap stays leak-free.
- **Test setup pattern**: `test/web/fetch.test.ts` mocks `node:dns/promises` via `vi.mock` and uses dynamic `await import(...)` of the module under test to ensure mock registration happens first. If anyone splits this file, the mock-then-import header pattern must be preserved.
- **Singleton cache across tests**: `clearCache()` is exported solely so tests can reset the module-level Map between cases. Production code does not call it.
- **`AnyModel` is `Model<any>`**: This mirrors the canonical usage across `@mariozechner/pi-coding-agent`. The eslint-disable for `no-explicit-any` is intentional (per AGENTS.md convention). Do not change to `Model<unknown>`.

## Constraints

- ESM with `.js` extensions in imports (per project convention).
- `@sinclair/typebox` for tool parameter schemas.
- Node ≥ 20.6.0 (required for `for await` on `fetch` response bodies).
- One new runtime dependency: `turndown` ^7.2.2.
