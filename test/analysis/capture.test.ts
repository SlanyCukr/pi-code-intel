import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	SYSTEM_PROMPT_CUSTOM_TYPE,
	installSystemPromptCapture,
} from "../../src/analysis/capture.js";

/**
 * The capture hook is the producer end of the system-prompt-grounding
 * feature. We test it by stubbing `pi` with the minimal surface it
 * uses (`on`, `appendEntry`, `getActiveTools`) and driving the captured
 * `before_agent_start` handler directly.
 */

interface FakePi {
	on: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	/** The captured handler from `pi.on("before_agent_start", h)`. */
	getHandler(): (event: { systemPrompt?: string }) => void;
}

function makeFakePi(opts: { withAppendEntry?: boolean; appendEntryThrows?: Error } = {}): FakePi {
	const captured: Array<(event: any) => void> = [];
	const fake: any = {
		on: vi.fn((eventName: string, handler: (event: any) => void) => {
			if (eventName === "before_agent_start") captured.push(handler);
		}),
		getActiveTools: vi.fn(() => ["read", "edit", "lsp"]),
	};
	if (opts.withAppendEntry !== false) {
		fake.appendEntry = vi.fn((customType: string, _data: unknown) => {
			if (opts.appendEntryThrows) throw opts.appendEntryThrows;
			void customType;
		});
	}
	fake.getHandler = () => {
		expect(captured).toHaveLength(1);
		return captured[0];
	};
	return fake as FakePi;
}

describe("installSystemPromptCapture", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it("registers a single before_agent_start handler", () => {
		const pi = makeFakePi();
		installSystemPromptCapture(pi as any);
		expect(pi.on).toHaveBeenCalledTimes(1);
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	it("appends an entry on first capture with text/hash/capturedAt/activeTools", () => {
		const pi = makeFakePi();
		installSystemPromptCapture(pi as any);
		const handler = pi.getHandler();
		handler({ systemPrompt: "you are a helpful agent" });

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const [customType, data] = pi.appendEntry.mock.calls[0];
		expect(customType).toBe(SYSTEM_PROMPT_CUSTOM_TYPE);
		expect(data).toMatchObject({
			text: "you are a helpful agent",
			activeTools: ["read", "edit", "lsp"],
		});
		// Hash is 16 hex chars (sha256 prefix).
		expect((data as { hash: string }).hash).toMatch(/^[0-9a-f]{16}$/);
		// capturedAt is a parseable ISO timestamp.
		expect(Number.isFinite(Date.parse((data as { capturedAt: string }).capturedAt))).toBe(true);
	});

	it("dedupes by hash: same prompt twice in a row writes only one entry", () => {
		const pi = makeFakePi();
		installSystemPromptCapture(pi as any);
		const handler = pi.getHandler();
		handler({ systemPrompt: "the same prompt" });
		handler({ systemPrompt: "the same prompt" });
		handler({ systemPrompt: "the same prompt" });
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("re-captures when the prompt changes", () => {
		const pi = makeFakePi();
		installSystemPromptCapture(pi as any);
		const handler = pi.getHandler();
		handler({ systemPrompt: "version A" });
		handler({ systemPrompt: "version B" });
		handler({ systemPrompt: "version A" }); // back to A — different from current B
		expect(pi.appendEntry).toHaveBeenCalledTimes(3);
	});

	it("ignores empty and missing system prompts", () => {
		const pi = makeFakePi();
		installSystemPromptCapture(pi as any);
		const handler = pi.getHandler();
		handler({ systemPrompt: "" });
		handler({});
		handler({ systemPrompt: undefined });
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("logs and disables itself when the SDK does not expose appendEntry", () => {
		const pi = makeFakePi({ withAppendEntry: false });
		installSystemPromptCapture(pi as any);
		expect(pi.on).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("SDK does not support appendEntry"),
		);
	});

	it("swallows appendEntry errors so a capture failure cannot abort the session", () => {
		const pi = makeFakePi({ appendEntryThrows: new Error("disk full") });
		installSystemPromptCapture(pi as any);
		const handler = pi.getHandler();
		expect(() => handler({ systemPrompt: "anything" })).not.toThrow();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("system prompt capture failed"),
			expect.stringContaining("disk full"),
		);
	});

	it("falls back to empty activeTools when getActiveTools is missing", () => {
		const pi: any = makeFakePi();
		delete pi.getActiveTools;
		installSystemPromptCapture(pi as any);
		const handler = pi.getHandler();
		handler({ systemPrompt: "x" });
		const data = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect((data as { activeTools: string[] }).activeTools).toEqual([]);
	});
});
