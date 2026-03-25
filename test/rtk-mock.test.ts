import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process before importing rtk
const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}));

// Import after mock is set up (vi.mock is hoisted)
const { rtkSpawnHook } = await import("../src/rtk.js");

const baseCtx = {
	command: "",
	cwd: process.cwd(),
	env: process.env,
};

describe("rtkSpawnHook (mocked)", () => {
	beforeEach(() => {
		mockExecFileSync.mockReset();
	});

	it("falls back to original command when rtk rewrite returns empty string", () => {
		mockExecFileSync.mockReturnValueOnce("");
		const result = rtkSpawnHook({ ...baseCtx, command: "some-command" });
		expect(result.command).toBe("some-command");
	});

	it("falls back to original command when rtk rewrite returns whitespace only", () => {
		mockExecFileSync.mockReturnValueOnce("  \n  ");
		const result = rtkSpawnHook({ ...baseCtx, command: "some-command" });
		expect(result.command).toBe("some-command");
	});

	it("logs unexpected errors (not exit code 1)", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = new Error("ENOENT");
		mockExecFileSync.mockImplementationOnce(() => { throw err; });
		const result = rtkSpawnHook({ ...baseCtx, command: "some-command" });
		expect(result.command).toBe("some-command");
		expect(consoleSpy).toHaveBeenCalledWith(
			"[code-intel] RTK rewrite failed unexpectedly:",
			"ENOENT",
		);
		consoleSpy.mockRestore();
	});

	it("does not log for expected exit code 1", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = Object.assign(new Error("exit 1"), { status: 1 });
		mockExecFileSync.mockImplementationOnce(() => { throw err; });
		const result = rtkSpawnHook({ ...baseCtx, command: "some-command" });
		expect(result.command).toBe("some-command");
		expect(consoleSpy).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});
