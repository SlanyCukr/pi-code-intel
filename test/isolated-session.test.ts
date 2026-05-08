import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReload = vi.fn(async () => {});

// Use a regular function (not arrow) so the mock supports `new`. The
// real DefaultResourceLoader is a class; arrow functions cannot be
// constructed.
vi.mock("@mariozechner/pi-coding-agent", () => {
	function MockLoader(this: any, opts: unknown) {
		this.__opts = opts;
		this.reload = mockReload;
	}
	return {
		DefaultResourceLoader: vi.fn(MockLoader as any),
		SessionManager: { inMemory: vi.fn((cwd: string) => ({ __cwd: cwd })) },
		getAgentDir: vi.fn(() => "/fake/agent/dir"),
		createAgentSession: vi.fn(async (opts: unknown) => ({
			session: { __opts: opts, dispose: vi.fn() },
		})),
	};
});

import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import { createIsolatedSession } from "../src/isolated-session.js";

const mockedLoader = vi.mocked(DefaultResourceLoader);
const mockedCreateSession = vi.mocked(createAgentSession);
const mockedSessionManager = vi.mocked(SessionManager);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createIsolatedSession", () => {
	it("constructs a DefaultResourceLoader with noExtensions+noSkills+noPromptTemplates+noThemes", async () => {
		await createIsolatedSession({ cwd: "/proj" });
		expect(mockedLoader).toHaveBeenCalledTimes(1);
		const opts = mockedLoader.mock.calls[0][0];
		expect(opts).toMatchObject({
			cwd: "/proj",
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
	});

	it("awaits the loader's reload before passing it to createAgentSession", async () => {
		await createIsolatedSession({ cwd: "/proj" });
		// reload was called and resolved before createAgentSession
		expect(mockReload).toHaveBeenCalledTimes(1);
		expect(mockedCreateSession).toHaveBeenCalledTimes(1);
		const sessionOpts = mockedCreateSession.mock.calls[0][0] as Record<string, unknown>;
		expect((sessionOpts.resourceLoader as { reload: unknown }).reload).toBe(mockReload);
	});

	it("forwards `model` and `cwd`, and overrides tools/sessionManager for isolation", async () => {
		const fakeModel = { provider: "x", id: "y" } as any;
		await createIsolatedSession({ cwd: "/work", model: fakeModel });
		const sessionOpts = mockedCreateSession.mock.calls[0][0] as Record<string, unknown>;
		expect(sessionOpts.cwd).toBe("/work");
		expect(sessionOpts.model).toBe(fakeModel);
		expect(sessionOpts.tools).toEqual([]);
		// In-memory session manager keyed on the same cwd
		expect(mockedSessionManager.inMemory).toHaveBeenCalledWith("/work");
		expect(sessionOpts.sessionManager).toMatchObject({ __cwd: "/work" });
	});

	it("returns whatever createAgentSession returns (passthrough)", async () => {
		const result = await createIsolatedSession({ cwd: "/x" });
		expect(result).toEqual(
			expect.objectContaining({
				session: expect.objectContaining({ dispose: expect.any(Function) }),
			}),
		);
	});
});
