import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireRtk, rtkSpawnHook } from "../src/rtk.js";

describe("requireRtk", () => {
	it("does not throw when RTK is installed", () => {
		expect(() => requireRtk()).not.toThrow();
	});
});

describe("rtkSpawnHook", () => {
	const baseCtx = {
		command: "",
		cwd: process.cwd(),
		env: process.env,
	};

	it("rewrites a known command via rtk rewrite", () => {
		const result = rtkSpawnHook({ ...baseCtx, command: "git status" });
		expect(result.command).toBe("rtk git status");
	});

	it("does not double-wrap commands already starting with rtk", () => {
		const result = rtkSpawnHook({ ...baseCtx, command: "rtk gain" });
		expect(result.command).toBe("rtk gain");
	});

	it("passes through commands RTK cannot rewrite", () => {
		const result = rtkSpawnHook({ ...baseCtx, command: "mkdir -p /tmp/test" });
		expect(result.command).toBe("mkdir -p /tmp/test");
	});

	it("handles compound commands intelligently", () => {
		const result = rtkSpawnHook({
			...baseCtx,
			command: "cd /tmp && git status",
		});
		expect(result.command).toBe("cd /tmp && rtk git status");
	});

	it("rewrites grep commands", () => {
		const result = rtkSpawnHook({
			...baseCtx,
			command: 'grep -rn "import" src/',
		});
		expect(result.command).toContain("rtk grep");
	});

	it("rewrites find commands", () => {
		const result = rtkSpawnHook({
			...baseCtx,
			command: "find . -name '*.ts'",
		});
		expect(result.command).toContain("rtk find");
	});

	it("rewrites ls commands", () => {
		const result = rtkSpawnHook({ ...baseCtx, command: "ls -la" });
		expect(result.command).toContain("rtk ls");
	});

	it("preserves cwd and env in the returned context", () => {
		const ctx = { command: "git status", cwd: "/custom/dir", env: { FOO: "bar" } };
		const result = rtkSpawnHook(ctx);
		expect(result.cwd).toBe("/custom/dir");
		expect(result.env).toEqual({ FOO: "bar" });
	});

	it("falls back to original command when rtk rewrite returns whitespace-only", () => {
		// rtk rewrite returns exit 0 with whitespace for commands it recognizes
		// but has no meaningful rewrite for. The hook should treat this as
		// "no rewrite" and return the original command.
		const result = rtkSpawnHook({ ...baseCtx, command: "echo hello" });
		// echo is not rewritten by rtk, so we get the original back.
		// This exercises the passthrough path (either empty rewrite or catch).
		expect(result.command).toBe("echo hello");
	});
});

// rtk's exit-code semantics drifted between versions:
//   - 0.31: exit 0 with stdout = rewrite
//   - 0.39: exit 3 with stdout = rewrite + a deprecation warning
// CI caught this when the unit tests fail-pinned exit 0 against a
// real rtk 0.39 binary. These tests pin the tolerance behavior so
// future drift to other non-zero exit codes keeps working as long
// as stdout has content.
//
// We mock node:child_process at the module boundary because ES module
// destructured imports (`import { execFileSync } from "node:child_process"`)
// can't be intercepted by vi.spyOn. The mock has to be hoisted to the
// top of the file, so we put the tolerance suite in its own describe
// guarded by a re-import that forces module re-evaluation.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import("node:child_process");
	return {
		...actual,
		execFileSync: vi.fn(actual.execFileSync),
	};
});

describe("rtkSpawnHook exit-code tolerance", async () => {
	// Re-import inside the describe so the mocked version is bound here.
	const { execFileSync } = await import("node:child_process");
	const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockExec.mockReset();
	});
	afterEach(() => {
		mockExec.mockReset();
	});

	const baseCtx = { command: "", cwd: process.cwd(), env: process.env };

	it("trusts stdout when rtk exits 3 (deprecation warning + valid rewrite)", () => {
		const err: any = new Error("Command failed");
		err.status = 3;
		err.stdout = "rtk git status";
		err.stderr = "[rtk] /!\\ Hook outdated";
		mockExec.mockImplementation(() => {
			throw err;
		});

		const result = rtkSpawnHook({ ...baseCtx, command: "git status" });
		expect(result.command).toBe("rtk git status");
	});

	it("trusts stdout for any non-zero exit code other than 1, given content", () => {
		const err: any = new Error("Command failed");
		err.status = 7;
		err.stdout = "rtk grep something";
		mockExec.mockImplementation(() => {
			throw err;
		});

		const result = rtkSpawnHook({ ...baseCtx, command: "grep something" });
		expect(result.command).toBe("rtk grep something");
	});

	it("falls back to original on exit 1 (no rewrite available)", () => {
		const err: any = new Error("Command failed");
		err.status = 1;
		err.stdout = "";
		mockExec.mockImplementation(() => {
			throw err;
		});

		const result = rtkSpawnHook({ ...baseCtx, command: "obscure-cmd" });
		expect(result.command).toBe("obscure-cmd");
	});

	it("falls back to original on non-zero exit with empty stdout", () => {
		const err: any = new Error("Command failed");
		err.status = 2;
		err.stdout = "";
		mockExec.mockImplementation(() => {
			throw err;
		});

		const result = rtkSpawnHook({ ...baseCtx, command: "some-cmd" });
		expect(result.command).toBe("some-cmd");
	});

	it("handles stdout returned as a Buffer (no encoding option)", () => {
		const err: any = new Error("Command failed");
		err.status = 3;
		err.stdout = Buffer.from("rtk ls -la", "utf-8");
		mockExec.mockImplementation(() => {
			throw err;
		});

		const result = rtkSpawnHook({ ...baseCtx, command: "ls -la" });
		expect(result.command).toBe("rtk ls -la");
	});
});
