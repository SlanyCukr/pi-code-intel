/**
 * Shared utilities for inspecting pi SDK agent messages.
 *
 * The SDK emits messages whose `content` is either a string or an array of
 * blocks (text, toolCall, toolResult, image). Several callers — the sub-agent
 * runner, the analysis proposer, and the web summarizer — need the same
 * "last assistant message text" walk. Centralising it here keeps the miss
 * semantics (null vs. empty string) consistent and means a future SDK change
 * to the block shape lands in one place.
 */

/** A pi SDK message as seen by callers that only care about role + content. */
export interface AgentMessageLike {
	role?: string;
	content?: unknown;
}

interface TextBlock {
	type?: string;
	text?: string;
}

/**
 * Walk a pi SDK message log backwards and return the last assistant message's
 * text content (newline-joined when the message contains multiple text blocks).
 *
 * Returns `null` when no assistant message has any text — e.g. tool-only turns,
 * empty sessions, or whitespace-only outputs.
 *
 * Non-text blocks (toolCall, toolResult, image, etc.) are skipped. The walk
 * does NOT concatenate text across multiple assistant messages: if the last
 * assistant message has only tool calls, the walk falls back to the previous
 * assistant message rather than treating the latest message as empty.
 */
export function lastAssistantText(messages: readonly unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as AgentMessageLike;
		if (msg?.role !== "assistant") continue;

		const parts: string[] = [];
		if (typeof msg.content === "string") {
			parts.push(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content as TextBlock[]) {
				if (block?.type === "text" && typeof block.text === "string" && block.text) {
					parts.push(block.text);
				}
			}
		}

		const text = parts.join("\n\n").trim();
		if (text) return text;
	}
	return null;
}
