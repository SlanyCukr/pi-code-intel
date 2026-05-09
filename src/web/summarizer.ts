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
 * tools) via `runIsolatedTextCall`. Aborts throw; an empty model
 * response degrades to truncated raw content rather than failing the
 * whole web fetch.
 */
export async function summarizeContent(options: SummarizeOptions): Promise<string> {
	const { content, prompt, cwd, model, signal } = options;

	if (content.length <= SMALL_CONTENT_THRESHOLD) {
		return content;
	}

	const result = await runIsolatedTextCall(
		buildExtractionPrompt(content, prompt),
		{ cwd, model, signal },
	);

	if (result.kind === "aborted") {
		throw new Error("Summarization aborted");
	}
	if (result.kind === "text") return result.text;

	console.error(
		"[code-intel] Web content summarization produced no text output from model, returning truncated raw content",
	);
	return (
		content.slice(0, SMALL_CONTENT_THRESHOLD) +
		"\n\n[Content summarization produced no output, showing truncated raw content]"
	);
}
