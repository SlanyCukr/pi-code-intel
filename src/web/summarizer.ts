import { createIsolatedSession } from "../isolated-session.js";
import type { AnyModel } from "../types.js";

/** Content below this threshold is returned as-is without model summarization. */
const SMALL_CONTENT_THRESHOLD = 30_000;

export interface SummarizeOptions {
	/** The markdown content to summarize */
	content: string;
	/** User's extraction prompt — what information to extract */
	prompt: string;
	/** Working directory for session storage */
	cwd: string;
	/** Model to use for summarization (inherits from parent session) */
	model?: AnyModel;
	/** Abort signal */
	signal?: AbortSignal;
}

/**
 * Build the extraction prompt for web content summarization.
 *
 * Wraps the web page content between horizontal-rule delimiters,
 * appends the user's extraction prompt, and instructs the model
 * to provide a concise response with code examples.
 */
export function buildExtractionPrompt(content: string, userPrompt: string): string {
	return `Web page content:
---
${content}
---

${userPrompt}

Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`;
}

/**
 * Summarize web content using a lightweight agent session.
 *
 * For small content (<=30K chars), returns the markdown directly.
 * For larger content, creates a single-turn agent session (no tools)
 * to extract the relevant information.
 */
export async function summarizeContent(options: SummarizeOptions): Promise<string> {
	const { content, prompt, cwd, model, signal } = options;

	// Small content: return directly without model call
	if (content.length <= SMALL_CONTENT_THRESHOLD) {
		return content;
	}

	// Refuse to spend a model call if we've already been aborted. EventTarget
	// does not replay past `abort` events, so a listener attached after
	// abort would never fire.
	if (signal?.aborted) {
		throw new Error("Summarization aborted");
	}

	// Create a minimal, isolated agent session for extraction.
	// Isolation matters: createAgentSession by default re-loads project
	// extensions, which would re-attach our own prompt rewriter and
	// silently overwrite `setSystemPrompt("")` on the next agent loop.
	const { session } = await createIsolatedSession({ cwd, model });

	// Window between createAgentSession (async) and listener attachment —
	// re-check so an abort that fired during session construction is not lost.
	if (signal?.aborted) {
		session.dispose();
		throw new Error("Summarization aborted");
	}

	let abortHandler: (() => void) | null = null;
	try {
		// Wire abort signal. session.abort() returns a Promise; swallow rejections
		// so a fire-and-forget abort cannot trigger an unhandled-rejection crash.
		if (signal) {
			abortHandler = () => {
				void session.abort().catch(() => {
					/* abort is best-effort */
				});
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		// Set empty system prompt — extraction prompt is self-contained
		session.agent.setSystemPrompt("");

		// Run the extraction prompt
		await session.prompt(buildExtractionPrompt(content, prompt));

		// Extract the response
		const messages = session.messages as Array<{ role: string; content: unknown }>;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;

			const parts: string[] = [];
			if (typeof msg.content === "string") {
				parts.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content as Array<{ type: string; text?: string }>) {
					if (block.type === "text" && block.text) {
						parts.push(block.text);
					}
				}
			}
			const text = parts.join("\n\n").trim();
			if (text) return text;
		}

		// Fallback: return truncated raw content
		console.error("[code-intel] Web content summarization produced no text output from model, returning truncated raw content");
		return content.slice(0, SMALL_CONTENT_THRESHOLD) + "\n\n[Content summarization produced no output, showing truncated raw content]";
	} finally {
		if (signal && abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
		session.dispose();
	}
}
