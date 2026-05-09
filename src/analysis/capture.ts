import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { asExtendedApi, safeGetActiveTools } from "../sdk-api.js";

/**
 * `customType` value used for system-prompt entries persisted via
 * `pi.appendEntry`. Single source of truth shared by the producer
 * (this module) and the consumer (`reader.ts`).
 */
export const SYSTEM_PROMPT_CUSTOM_TYPE = "code-intel:system-prompt";

/**
 * Install a `before_agent_start` handler that records the rendered
 * system prompt to the session JSONL on every change. Hash-deduped so
 * a steady-state session writes exactly one capture per change to the
 * prompt (typically once per session, occasionally more if AGENTS.md
 * is edited mid-session, the active tool set changes, or other
 * extensions chain modifications).
 *
 * Per-session dedupe: when the user switches sessions (`/new`,
 * `/resume`, fork, etc.), the in-process closure's `lastPromptHash` is
 * reset so the next agent loop in the new session writes a capture
 * even if the prompt text is unchanged. Without this reset, two
 * sessions with the same prompt would produce captures only in the
 * first — and any later analysis of the second session would fall
 * back to source-grounding instead of the actual prompt the agent saw.
 *
 * Failure mode: any error from `pi.appendEntry` is logged and swallowed.
 * A capture failure must NEVER abort the session.
 *
 * Caller is expected to register this AFTER any extension hooks that
 * mutate `event.systemPrompt` (e.g. our own prompt rewriter), so the
 * captured text reflects what the LLM actually sees at the position of
 * this handler. Limitations across extensions are documented in the
 * extension entry point.
 *
 * SDK compatibility: `appendEntry` was added in pi-coding-agent ^0.62.
 * If the runtime SDK doesn't expose it (older host), capture is logged
 * as disabled and the rest of the extension continues to work.
 */
export function installSystemPromptCapture(pi: ExtensionAPI): void {
	const sdk = asExtendedApi(pi);
	if (typeof sdk.appendEntry !== "function") {
		console.error(
			"[code-intel] SDK does not support appendEntry — system prompt capture disabled",
		);
		return;
	}

	let lastPromptHash = "";
	pi.on("before_agent_start", (event) => {
		const text = event.systemPrompt ?? "";
		if (!text) return;
		const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
		if (hash === lastPromptHash) return;
		lastPromptHash = hash;
		try {
			sdk.appendEntry!(SYSTEM_PROMPT_CUSTOM_TYPE, {
				text,
				hash,
				capturedAt: new Date().toISOString(),
				activeTools: safeGetActiveTools(pi),
			});
		} catch (err) {
			// Capture failures must never abort the session.
			console.error(
				"[code-intel] system prompt capture failed:",
				err instanceof Error ? err.message : err,
			);
		}
	});

	// Reset the dedupe hash on every session-boundary event that produces
	// a NEW JSONL file. Each new file needs at least one capture even if
	// its prompt text matches the previous file's — otherwise propose-
	// mode falls back to source-grounding for that session.
	//
	// Events that create a new file (need reset):
	//   - session_switch (reason="new" or "resume"): /new, /resume
	//   - session_fork: branching into a fresh JSONL
	//
	// Events that stay in the same file (do NOT need reset):
	//   - session_compact: appendCompaction() writes to the existing
	//     SessionManager, so prior captures remain in the same JSONL.
	//     Verified in agent-session.js:1338, 1522.
	//   - session_tree: sessionManager.branch(leafId) only changes the
	//     current leaf within the existing file. Verified in
	//     agent-session.js:2376.
	//
	// If a new event type is added to the SDK that creates a new file,
	// it MUST be added here. The `Test discipline` rule in AGENTS.md
	// covers this case under "Adjacent SDK events you didn't hook".
	const resetHash = (): void => {
		lastPromptHash = "";
	};
	pi.on("session_switch", resetHash);
	pi.on("session_fork", resetHash);
}
