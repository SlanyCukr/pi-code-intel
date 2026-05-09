import {
	createIsolatedSession,
	type IsolatedSessionOptions,
} from "../isolated-session.js";
import { lastAssistantText } from "./agent-messages.js";

export type IsolatedTextCallResult =
	| { kind: "text"; text: string }
	| { kind: "no-text" }
	| { kind: "aborted"; phase: "before" | "during-setup" };

export interface IsolatedTextCallOptions extends IsolatedSessionOptions {
	signal?: AbortSignal;
	/** System prompt to set on the inner session before prompting. Defaults to "". */
	systemPrompt?: string;
}

/**
 * Run a single-turn isolated LLM call and return the assistant text.
 *
 * Encapsulates the abort+lifecycle pattern shared by
 * `web/summarizer.ts` and `analysis/propose.ts`:
 *  - Pre-create signal check (no LLM call attempted).
 *  - Post-create signal check covering the async window between
 *    `createIsolatedSession` resolving and the abort listener attaching
 *    — `EventTarget` does not replay past `abort` events.
 *  - Abort handler attached for the duration of `session.prompt`,
 *    fire-and-forget so a rejected `session.abort()` cannot trigger an
 *    unhandled-rejection crash on Node's default policy.
 *  - Session disposed in finally regardless of outcome.
 *
 * Errors from `createIsolatedSession` or `session.prompt` propagate;
 * callers wrap as their error policy demands. Aborts at supported
 * phases return a typed result instead of throwing so callers can
 * distinguish "user cancelled" from "model failed".
 *
 * Lives in its own module (rather than alongside `createIsolatedSession`)
 * so unit tests can mock the SDK boundary via `vi.mock` while the helper
 * runs unchanged.
 */
export async function runIsolatedTextCall(
	userPrompt: string,
	options: IsolatedTextCallOptions,
): Promise<IsolatedTextCallResult> {
	const { signal, systemPrompt = "", ...sessionOptions } = options;

	if (signal?.aborted) return { kind: "aborted", phase: "before" };

	const { session } = await createIsolatedSession(sessionOptions);

	if (signal?.aborted) {
		session.dispose();
		return { kind: "aborted", phase: "during-setup" };
	}

	let abortHandler: (() => void) | null = null;
	try {
		if (signal) {
			abortHandler = () => {
				void session.abort().catch(() => {
					/* abort is best-effort */
				});
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		session.agent.setSystemPrompt(systemPrompt);
		await session.prompt(userPrompt);
		const text = lastAssistantText(session.messages);
		return text != null ? { kind: "text", text } : { kind: "no-text" };
	} finally {
		if (signal && abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
		session.dispose();
	}
}
