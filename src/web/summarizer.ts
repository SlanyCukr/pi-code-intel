import { runIsolatedTextCall } from "../utils/isolated-text-call.js";
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
 * For larger content, runs a single-turn isolated agent session (no
 * tools) via `runIsolatedTextCall`. Aborts (any phase), empty-output,
 * and thrown errors all degrade to truncated raw content with a status
 * note — matching `analysis/propose.ts`, the fetch tool always returns
 * markdown so a cancelled or failed summarize never aborts the whole
 * tool call.
 */
export async function summarizeContent(options: SummarizeOptions): Promise<string> {
	const { content, prompt, cwd, model, signal } = options;

	if (content.length <= SMALL_CONTENT_THRESHOLD) {
		return content;
	}

	let reason: string;
	try {
		const result = await runIsolatedTextCall(
			buildExtractionPrompt(content, prompt),
			{ cwd, model, signal },
		);
		if (result.kind === "text") return result.text;
		reason = result.kind === "aborted" ? "aborted" : "produced no output";
	} catch (err) {
		// During-prompt aborts surface here as a thrown rejection from
		// session.abort() resolving prompt(); other failures (model error,
		// network) take the same path. Both fall through to the markdown
		// fallback so the fetch tool stays consumable.
		reason =
			err instanceof Error && /abort/i.test(err.message)
				? "aborted"
				: `failed: ${err instanceof Error ? err.message : String(err)}`;
	}

	console.error(`[code-intel] Web content summarization fallback: ${reason}`);
	return (
		content.slice(0, SMALL_CONTENT_THRESHOLD) +
		`\n\n[Content summarization ${reason}, showing truncated raw content]`
	);
}
