import { describe, it, expect } from "vitest";
import { lastAssistantText } from "../../src/utils/agent-messages.js";

describe("lastAssistantText", () => {
	it("returns the last assistant text content joined with double newlines", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		];
		expect(lastAssistantText(messages)).toBe("first\n\nsecond");
	});

	it("returns null when no assistant message has text", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "toolCall" }] },
		];
		expect(lastAssistantText(messages)).toBeNull();
	});

	it("handles string content directly", () => {
		const messages = [{ role: "assistant", content: "hello world" }];
		expect(lastAssistantText(messages)).toBe("hello world");
	});
});
