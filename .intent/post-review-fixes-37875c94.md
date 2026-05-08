# Intent: Post-review correctness, security, and robustness fix-up

**Created**: 2026-05-07
**ID**: post-review-fixes-37875c94

---

## Problem Statement

A code review of `pi-code-intel` surfaced 11 issues spanning real bugs (LSP correctness, race conditions), security gaps (SSRF, late body-size enforcement), and cross-platform robustness (Windows path resolution, fragile extension parsing). Each issue is contained, but several have user-visible consequences: invalid URIs sent to LSP servers, lost LSP clients after init failures, and an LLM-controlled `fetch` tool that can reach cloud-metadata endpoints. This pass closes all of them in one coherent fix-up.

## Scope

**In scope:**
- Three real LSP bugs: `fileToUri` percent-encoding, exit-handler race in `LspClientManager`, dropped `MarkedString[]` hover content
- Two `fetch` security hardenings: SSRF blocklist with DNS resolution, streaming body-size enforcement
- Three robustness fixes: cross-platform `isCommandAvailable`, `extname()` migration in two call sites, regex escaping in frontmatter parser
- Two minor nits: balanced quote stripping in `getString`, redundant `removeEventListener` cleanup in `runner.ts`
- Two robustness extensions to `runner.ts` discovered while touching the file for the cleanup nit: a configurable sub-agent timeout (default 5 minutes) and an additional `message_update` progress event for streaming partial assistant text to the parent — see FR-10 / FR-11 below
- One redirect-SSRF hardening in `src/web/fetch.ts` discovered during review of the FR-4/FR-5 changes: manual redirect following with per-hop SSRF revalidation. See FR-12 below.
- Four findings from a focused code review of `src/web/context7.ts` and `src/web/summarizer.ts` (the two files earlier wider reviews timed out before reaching). See FR-13 / FR-14 / FR-15 / FR-16 below.
- Regression tests for each of the above
- Updates to existing tests that enshrine buggy behavior (`test/lsp/utils.test.ts:25-29`)

**Out of scope:**
- The `config.ts` "partial section objects" nit — no actionable bug
- Any refactor of `LspClientManager` lifecycle beyond the identity-guard fix
- Any change to the public extension API or tool schemas
- Support for `.exe` shimming on non-Windows platforms

## Requirements

### Functional Requirements

- **FR-1**: `fileToUri(path)` MUST return RFC 3986–compliant URIs for paths containing spaces, `#`, `?`, `%`, `[`, `]`, and non-ASCII characters. `uriToFile(fileToUri(p)) === p` for any absolute path `p`.
- **FR-2**: When an LSP server's `spawnAndInitialize` fails and a retry succeeds under the same server name, the failed child's eventual `exit` event MUST NOT remove the new client from `LspClientManager.clients`.
- **FR-3**: `formatHover` MUST render `MarkedString[]` content (LSP spec form) by joining all elements with `\n\n`, falling back to "No hover information available." only when every element is empty.
- **FR-4**: `fetchUrl` MUST refuse to issue requests to loopback addresses (127.0.0.0/8, ::1), RFC 1918 private ranges (10/8, 172.16/12, 192.168/16), link-local ranges (169.254/16, fe80::/10, including cloud-metadata 169.254.169.254), and IPv6 unique-local (fc00::/7). The check MUST resolve the hostname via DNS before deciding, so `localtest.me`-style indirection cannot bypass.
- **FR-5**: `fetchUrl` MUST stream `response.body` and abort once cumulative bytes exceed `MAX_RESPONSE_BYTES`, without buffering the full payload first.
- **FR-6**: `isCommandAvailable` MUST resolve commands on Windows by appending each entry of `PATHEXT` (default `.COM;.EXE;.BAT;.CMD`) when the bare name is not present.
- **FR-7**: `getLanguageId` and `getServersForFile` MUST treat extensionless files as having no extension (use `extname()`), not as having a single-character extension equal to the last filename character.
- **FR-8**: `getString`/`getArray` in `frontmatter.ts` MUST escape regex metacharacters in the `key` parameter.
- **FR-9**: `getString`'s quote stripping MUST only strip a leading/trailing quote pair when both quotes match (`"foo"` → `foo`, but leave `'foo"` untouched).
- **FR-10**: `runSubAgent` MUST accept an optional `timeout` (ms; default 15 minutes; `0` disables) and abort the session when the timeout fires. When a timeout fires, the function MUST still return any partial output collected so far, plus an `error` field describing the timeout. The timeout timer MUST be cleared in the `finally` block so a session that completes normally never leaks a pending timer. The default of 15 minutes (raised from an earlier 5-minute value that empirically killed productive review-heavy runs) applies when no override is supplied.
- **FR-10a**: The `agent` tool MUST expose an optional `timeoutMs` parameter so the calling LLM can request a longer window for known-complex tasks. The parameter MUST be schema-bounded to `[30000, 1800000]` (30s–30min) so an out-of-range value fails at validation rather than silently clamping. Omitting `timeoutMs` MUST defer to `runSubAgent`'s default.
- **FR-11**: `runSubAgent` MUST forward `message_update` events from the underlying `AgentSession` to its `onProgress` callback as `finding: <preview>` lines, where the preview is the latest assistant text truncated to 120 characters with an ellipsis. This is additive to the existing `tool_execution_*` progress events and gives the parent agent visibility into long-running sub-agent reasoning between tool calls.
- **FR-12**: `fetchUrl` MUST follow HTTP redirects manually (`redirect: "manual"`) and re-run the SSRF guard against every redirect target before issuing the next fetch. The number of redirects MUST be capped (default 10). Redirects with a missing or invalid `Location` header, or with a non-HTTP(S) scheme, MUST be rejected. This closes a gap in FR-4: with `redirect: "follow"`, a server-side 302 from a public host to 169.254.169.254 (or any private address) would have been followed unchecked.
- **FR-13**: `Context7Client._start` MUST install identity-guarded `data` / `error` / `exit` handlers on the spawned child process. Each handler captures the spawned process reference and short-circuits when `this.process !== proc`. This prevents a late `exit` from a previously-killed process from rejecting the new client's pending requests, marking it uninitialized, or concatenating residual stdout into the new buffer.
- **FR-14**: `Context7Client.processBuffer` MUST reject any frame whose `Content-Length` exceeds a fixed cap (`MAX_FRAME_BYTES`, default 10MB), is negative, or is non-finite. Bogus framing means subsequent bytes are unparseable, so the entire process MUST be torn down via `stop()` so the next call forces a clean restart. This caps memory exposure if a compromised MCP package emits a giant `Content-Length`.
- **FR-15**: `summarizeContent` MUST short-circuit with a thrown `Summarization aborted` error if `signal?.aborted` is already true at entry (after the small-content branch), and MUST re-check `signal?.aborted` immediately after `createAgentSession` resolves — disposing the freshly-created session and throwing if so. `EventTarget` does not replay past `abort` events, so a listener attached after the abort would never fire; both checks are required.
- **FR-16**: `summarizeContent`'s abort handler MUST NOT propagate rejections from `session.abort()`. Wrap with `.catch(() => {})` so a fire-and-forget abort cannot escalate to an unhandled rejection (which is fatal under Node's default `--unhandled-rejections=throw`).

### Non-Functional Requirements

- **NFR-1**: All 251 existing tests MUST continue to pass. New regression tests added for each fix.
- **NFR-2**: No new runtime dependencies. All changes use Node stdlib (`node:url`, `node:dns/promises`, `node:net`, `node:path`).
- **NFR-3**: The SSRF DNS resolution MUST honor the abort signal and the existing 15s fetch timeout — the resolution itself adds at most one DNS round-trip to the existing fetch latency.
- **NFR-4**: TypeScript strict mode passes; `npm run typecheck` clean.

## Architectural Decisions

### Decision: Use Node stdlib for URI conversion
**Chosen approach**: Replace hand-rolled `fileToUri` / `uriToFile` with `pathToFileURL().href` / `fileURLToPath()` from `node:url`.
**Rationale**: Canonical RFC 3986 implementation, handles Windows drive letters, percent-encoding, and round-tripping correctly. Removes 12 lines of custom code that was both wrong and untested for edge cases.
**Trade-offs accepted**: The output for ASCII-only paths is byte-identical to the old implementation, so callers see no change there. Existing test that asserts the buggy unencoded form will be replaced with one that asserts correct encoding plus a round-trip test.

### Decision: Identity-guard map deletions in LSP exit/error handlers
**Chosen approach**: Both `child.on("exit")` and `child.on("error")` handlers in `spawnAndInitialize` check `this.clients.get(serverName) === client` before deleting, and also clear `this.initializing` defensively.
**Rationale**: Smallest possible fix that closes the race. No restructuring of the client lifecycle, no new abstractions.
**Trade-offs accepted**: The fix is per-handler boilerplate (two near-identical guards). Acceptable because both handlers exist on the same child and need the same check.

### Decision: SSRF check via dual-pass — string parse + DNS resolve
**Chosen approach**: Parse the URL hostname; if it's already a literal IP, check it against the blocklist; otherwise `dns.lookup(hostname, { all: true })` and check every resolved address. Use `node:net.isIP` to recognize literals and `node:dns/promises`. Provide a single `assertSafeUrl(url, signal)` helper colocated in `fetch.ts`.
**Rationale**: Catches both `http://127.0.0.1` (literal) and `http://localtest.me` (DNS-resolves to 127.0.0.1) without needing a third-party library. Uses Node stdlib only.
**Trade-offs accepted**: One DNS round-trip per fetch (already cheap; cached by the OS resolver). TOCTOU between `dns.lookup` and the actual `fetch` call is theoretical — exploiting it requires a hostile DNS server changing answers between the two calls — and is outside the threat model for an LLM-typo-controlled URL. No custom resolver hook into `fetch` is needed.

### Decision: Stream body via async iteration of `response.body`
**Chosen approach**: Replace `await response.text()` with a `for await (const chunk of response.body)` loop that accumulates chunks into a `Buffer[]`, tracks cumulative byte length, and aborts the controller (throwing) the moment the limit is exceeded. Decode the buffer to UTF-8 once at the end.
**Rationale**: Node 20+ supports async iteration on `fetch` response bodies. No extra dependency, and the limit is now actually enforced byte-by-byte rather than checked after-the-fact.
**Trade-offs accepted**: A small amount of extra code (~20 lines) compared to `response.text()`. Worth it for real enforcement.

### Decision: Cross-platform PATH lookup via `PATHEXT` on Windows only
**Chosen approach**: In `isCommandAvailable`, on `process.platform === "win32"`, additionally probe `cmd + ext` for each entry in `process.env.PATHEXT?.split(";")` (default `.COM;.EXE;.BAT;.CMD`). On other platforms, current behavior is unchanged.
**Rationale**: Windows is the only platform where the `PATH` lookup needs extension probing; Unix already gets the right answer with bare `existsSync`. Keeping the Unix path unchanged avoids any risk of regressions on the primary supported platform.
**Trade-offs accepted**: Does not check the executable bit on Unix (a non-executable file with the right name is treated as available). The pre-existing behavior; not in scope to change.

### Decision: One intent doc, one PR
**Chosen approach**: All 11 fixes ship together under one intent doc.
**Rationale**: They share the same review context and the same "post-review fix-up" framing. Splitting would multiply review overhead with no benefit.
**Trade-offs accepted**: A single PR touches more files. Each fix is self-contained, so reviewers can still evaluate them independently.

## Implementation Plan

### Files to Create

| File | Purpose |
|------|---------|
| `test/web/fetch-ssrf.test.ts` | Regression tests for SSRF blocklist (literal IP and DNS-resolved hostname). May be merged into existing `test/web/fetch.test.ts` if it fits cleanly there. |

(Likely no other new files — most fixes go into existing modules and existing test files.)

### Files to Modify

| File | Change |
|------|--------|
| `src/lsp/utils.ts` | (#1) Replace `fileToUri`/`uriToFile` bodies with `pathToFileURL`/`fileURLToPath`. (#3) Extend `formatHover` to handle `MarkedString \| MarkedString[]`. (#7) Replace `slice(lastIndexOf("."))` in `getLanguageId` with `extname()`. |
| `src/lsp/types.ts` | (#3) Widen `Hover.contents` to `MarkupContent \| MarkedString \| MarkedString[]`; add `MarkedString` type alias matching the LSP spec (`string \| { language: string; value: string }`). |
| `src/lsp/client.ts` | (#2) Add identity-guard to both `exit` and `error` handlers in `spawnAndInitialize`. |
| `src/lsp/config.ts` | (#6) Add Windows `PATHEXT` probing in `isCommandAvailable`. (#7) Replace `slice(lastIndexOf("."))` in `getServersForFile` with `extname()`. |
| `src/web/fetch.ts` | (#4) Add `assertSafeUrl(url, signal)` using `node:net` + `node:dns/promises`; call it before issuing the fetch. (#5) Replace `await response.text()` with a streaming reader that aborts on `MAX_RESPONSE_BYTES`. (#12) Switch `fetch` to `redirect: "manual"` and follow redirects in a loop, calling `assertSafeUrl` on every hop, capping at 10 redirects, and rejecting non-HTTP(S) `Location` schemes. (Listener-ordering, from the web-fetch-tool intent's known-gaps list) Move the external-signal listener attachment to BEFORE `assertSafeUrl`, and clear the fetch timeout in the cache-hit return path so the listener wrap stays leak-free. |
| `src/web/context7.ts` | (#13) Identity-guard the `data` / `error` / `exit` handlers spawned in `_start`. (#14) Cap accepted `Content-Length` at `MAX_FRAME_BYTES` (10MB); call `stop()` on bogus framing. |
| `src/web/summarizer.ts` | (#15) Add pre- and post-`createAgentSession` `signal?.aborted` short-circuits. (#16) Wrap the abort handler's `session.abort()` call in `.catch(() => {})`. |
| `src/utils/frontmatter.ts` | (#8) Add `escapeRegex` helper and apply to `key` in both `getString` and `getArray`. (Nit) Tighten `getString` quote stripping to require matching pair. |
| `src/agents/runner.ts` | (Nit) Drop the redundant `signal.removeEventListener(abort, abortHandler)` in the `finally` block — `{ once: true }` already removes the listener after firing. (#10) Add an optional `timeout` option (default 15 minutes; `0` disables) that aborts the session and surfaces a `timedOut` error in the result. (#11) Forward `message_update` events from the underlying `AgentSession` as `finding: <preview>` progress updates (preview truncated to 120 chars). |
| `src/agents/tool.ts` | (#10a) Add an optional `timeoutMs` parameter to the `agent` tool schema, bounded `[30000, 1800000]`, and forward it to `runSubAgent` as `timeout`. |
| `test/lsp/utils.test.ts` | Update the `fileToUri "converts path with spaces"` case to assert percent-encoded output, plus a round-trip test through `uriToFile`. Add `formatHover` test cases for `MarkedString[]`. |
| `test/lsp/client.test.ts` | Add a regression test for the exit-handler race: simulate failed init, then a successful retry, then the late exit event from the failed child. |
| `test/lsp/config.test.ts` | Add a test for Windows `PATHEXT` resolution (mocked `process.platform`). |
| `test/web/fetch.test.ts` | Add SSRF regression cases (literal `127.0.0.1`, `169.254.169.254`, hostname resolving to a private IP via mocked `dns.lookup`). Add a streaming size-limit regression case (server sends > `MAX_RESPONSE_BYTES`). Add redirect-SSRF cases (302 to literal private IP, 301 to hostname resolving to private IP, redirect cap, non-HTTP redirect scheme, missing `Location` header) and a positive multi-hop redirect case. |
| `test/web/context7.test.ts` | Add stale-handler regression: stop()+start() then deliver a late `exit` from the killed process; assert the new process's pending request still resolves. Add oversized-Content-Length regression: header advertising 2GB tears down the process. |
| `test/web/summarizer.test.ts` | Add already-aborted regression: aborted signal at entry throws without calling `createAgentSession`. Add abort-handler-rejection regression: a `session.abort()` that returns a rejected promise must not produce an unhandled rejection. |
| `test/utils/frontmatter.test.ts` | Add tests for keys containing regex metacharacters and for mismatched quote pairs. |
| `test/agents/runner.test.ts` | Add coverage for the timeout path (timed-out result returns partial output + error; timer cleared on normal completion) and the `message_update` progress forwarding (preview truncated to 120 chars). |
| `test/agents/tool.test.ts` | Add coverage for `timeoutMs` plumbing: explicit value forwarded as `timeout`; absent value yields `timeout: undefined` (runner default applies). |

## Edge Cases and Error Handling

- **Path with `%` characters**: After fix, `fileToUri("/home/user/100%.txt")` returns `file:///home/user/100%25.txt`; `uriToFile` round-trips back to the original.
- **Windows drive letter**: `pathToFileURL("C:\\foo")` already produces `file:///C:/foo` correctly. The current behavior is preserved.
- **Already-running LSP retry race**: After fix, the late exit event from a failed child is a no-op when a successful retry's client occupies the same key.
- **`MarkedString[]` with mixed forms**: Each element is rendered: strings as-is, `{ language, value }` as fenced code blocks (` ```${language}\n${value}\n``` `). Empty array → "No hover information available."
- **SSRF — DNS resolution fails**: Treated as fetch failure with the underlying DNS error message. We do not silently allow.
- **SSRF — IPv6 mapped IPv4** (`::ffff:127.0.0.1`): Detected and blocked. `node:net.isIPv6` plus prefix check.
- **Streaming size limit hit mid-body**: Abort the fetch controller, throw `Response too large (> MAX_RESPONSE_BYTES bytes): <url>` consistent with the existing pre-read check error message.
- **Streaming with no body** (HEAD-like response, 204): The async iterator simply yields zero chunks; result is empty string. No error.
- **Windows `PATHEXT` unset**: Default to `.COM;.EXE;.BAT;.CMD` (Windows itself uses this when the env var is unset).
- **Frontmatter key with regex metacharacters**: Currently no caller passes such a key; the escape is defensive future-proofing.
- **`getString` with single quote on left, double on right**: After fix, returns the value unchanged (with both quotes intact). Today's behavior strips both, producing a corrupt value silently.
- **Redirect chain that ends in a private IP**: `assertSafeUrl` rejects the final hop before the body is read — the agent receives a `private/loopback` error referencing the redirect target.
- **Redirect with relative `Location`**: Resolved against the previous hop URL via `new URL(location, currentUrl)`. Same-origin and cross-origin redirects are both supported as long as every hop passes the SSRF guard.
- **Sub-agent timeout fires mid-prompt**: `session.abort()` interrupts the underlying agent loop. The catch block extracts whatever final assistant text was already produced and returns it alongside the timeout error message; the caller can surface partial output.

## Constraints

- No new runtime dependencies; Node stdlib only (Node ≥ 20.6.0 per `package.json` engines).
- Project follows ES modules with `.js` extensions in imports — preserved in all new code.
- All bash commands continue to route through RTK; this PR adds no new bash usage in production code.
- `npm run build && npm test` MUST pass before this is considered complete (per `AGENTS.md`).
- Diff stays surgical: no opportunistic refactors, no formatting churn, no rename of unrelated symbols.
