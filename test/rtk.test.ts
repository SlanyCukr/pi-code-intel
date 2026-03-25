import { describe, it, expect } from "vitest";
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
