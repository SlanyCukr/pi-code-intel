import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/isolated-session.js", () => ({
	createIsolatedSession: vi.fn(),
}));

import { createIsolatedSession } from "../../src/isolated-session.js";
import { runIsolatedTextCall } from "../../src/utils/isolated-text-call.js";

const mockCreate = vi.mocked(createIsolatedSession);

beforeEach(() => {
	vi.clearAllMocks();
});

function makeFakeSession(messages: Array<{ role: string; content: unknown }>) {
	return {
		agent: { setSystemPrompt: vi.fn() },
		prompt: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
		dispose: vi.fn(),
		messages,
	};
}

describe("runIsolatedTextCall", () => {
	it("returns text result when assistant emits text", async () => {
		const session = makeFakeSession([
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		]);
		mockCreate.mockResolvedValueOnce({ session: session as any } as any);

		const result = await runIsolatedTextCall("hi", { cwd: "/x" });

		expect(result).toEqual({ kind: "text", text: "hello" });
		expect(session.agent.setSystemPrompt).toHaveBeenCalledWith("");
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	it("forwards a custom systemPrompt to the inner session", async () => {
		const session = makeFakeSession([
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
		mockCreate.mockResolvedValueOnce({ session: session as any } as any);

		await runIsolatedTextCall("prompt", { cwd: "/x", systemPrompt: "custom" });

		expect(session.agent.setSystemPrompt).toHaveBeenCalledWith("custom");
	});

	it("returns no-text when the assistant emits no text", async () => {
		const session = makeFakeSession([{ role: "assistant", content: [] }]);
		mockCreate.mockResolvedValueOnce({ session: session as any } as any);

		const result = await runIsolatedTextCall("p", { cwd: "/x" });

		expect(result).toEqual({ kind: "no-text" });
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	it("short-circuits with phase=before when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();

		const result = await runIsolatedTextCall("p", { cwd: "/x", signal: ac.signal });

		expect(result).toEqual({ kind: "aborted", phase: "before" });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("returns phase=during-setup when signal aborts between create and listener", async () => {
		const session = makeFakeSession([]);
		const ac = new AbortController();
		mockCreate.mockImplementationOnce(async () => {
			ac.abort();
			return { session: session as any } as any;
		});

		const result = await runIsolatedTextCall("p", { cwd: "/x", signal: ac.signal });

		expect(result).toEqual({ kind: "aborted", phase: "during-setup" });
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("disposes the session even when session.prompt throws", async () => {
		const session = makeFakeSession([]);
		session.prompt.mockRejectedValueOnce(new Error("boom"));
		mockCreate.mockResolvedValueOnce({ session: session as any } as any);

		await expect(
			runIsolatedTextCall("p", { cwd: "/x" }),
		).rejects.toThrow("boom");

		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	it("removes the abort listener after the prompt completes", async () => {
		const session = makeFakeSession([
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
		mockCreate.mockResolvedValueOnce({ session: session as any } as any);
		const ac = new AbortController();
		const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

		await runIsolatedTextCall("p", { cwd: "/x", signal: ac.signal });

		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("swallows session.abort() rejections so a fired abort cannot crash the process", async () => {
		const session = makeFakeSession([
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
		session.abort.mockRejectedValueOnce(new Error("abort failed"));
		mockCreate.mockResolvedValueOnce({ session: session as any } as any);
		const ac = new AbortController();

		// Race: prompt resolves immediately, but in the meantime fire abort.
		session.prompt.mockImplementationOnce(async () => {
			ac.abort();
		});

		await expect(
			runIsolatedTextCall("p", { cwd: "/x", signal: ac.signal }),
		).resolves.toEqual({ kind: "text", text: "ok" });
	});
});
