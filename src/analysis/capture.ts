import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
	const piAny = pi as unknown as {
		appendEntry?: (customType: string, data: unknown) => void;
		getActiveTools?: () => string[];
	};
	if (typeof piAny.appendEntry !== "function") {
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
			piAny.appendEntry!(SYSTEM_PROMPT_CUSTOM_TYPE, {
				text,
				hash,
				capturedAt: new Date().toISOString(),
				activeTools:
					typeof piAny.getActiveTools === "function" ? piAny.getActiveTools() : [],
			});
		} catch (err) {
			// Capture failures must never abort the session.
			console.error(
				"[code-intel] system prompt capture failed:",
				err instanceof Error ? err.message : err,
			);
		}
	});

	// Reset the dedupe hash whenever pi switches to another session
	// ("/new", "/resume", forks, branches). Each session's JSONL needs
	// at least one capture even if its prompt text matches the previous
	// session's — otherwise propose-mode falls back to source-grounding
	// for that session.
	pi.on("session_switch", () => {
		lastPromptHash = "";
	});
}
