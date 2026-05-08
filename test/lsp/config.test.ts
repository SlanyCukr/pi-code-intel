import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProjectServers, getServersForFile, loadLspConfig } from "../../src/lsp/config.js";
import type { ServerConfig } from "../../src/lsp/types.js";

describe("getServersForFile", () => {
	const servers: Record<string, ServerConfig> = {
		"typescript-language-server": {
			command: "typescript-language-server",
			args: ["--stdio"],
			fileTypes: [".ts", ".tsx", ".js", ".jsx"],
			rootMarkers: ["tsconfig.json"],
		},
		eslint: {
			command: "vscode-eslint-language-server",
			args: ["--stdio"],
			fileTypes: [".ts", ".tsx", ".js", ".jsx"],
			rootMarkers: [".eslintrc"],
			isLinter: true,
		},
		pyright: {
			command: "pyright-langserver",
			args: ["--stdio"],
			fileTypes: [".py"],
			rootMarkers: ["pyproject.toml"],
		},
	};

	const config = { servers };

	it("returns matching servers for .ts files", () => {
		const result = getServersForFile(config, "test.ts");
		expect(result.length).toBe(2);
		expect(result[0].name).toBe("typescript-language-server");
		expect(result[1].name).toBe("eslint");
	});

	it("returns non-linters first", () => {
		const result = getServersForFile(config, "app.tsx");
		expect(result[0].config.isLinter).toBeFalsy();
		expect(result[1].config.isLinter).toBe(true);
	});

	it("returns matching servers for .py files", () => {
		const result = getServersForFile(config, "script.py");
		expect(result.length).toBe(1);
		expect(result[0].name).toBe("pyright");
	});

	it("returns empty for unknown extensions", () => {
		const result = getServersForFile(config, "file.xyz");
		expect(result.length).toBe(0);
	});

	it("returns empty for files without an extension", () => {
		// Regression: previously `slice(lastIndexOf("."))` returned the last
		// character of the filename when no `.` was present, producing a fake
		// one-letter extension. Now `extname()` correctly returns "".
		expect(getServersForFile(config, "Makefile")).toEqual([]);
		expect(getServersForFile(config, "/etc/passwd")).toEqual([]);
	});

	it("matches by extension from full paths", () => {
		const result = getServersForFile(
			config,
			"/home/user/project/src/main.ts",
		);
		expect(result.length).toBe(2);
	});
});

// -- Windows PATHEXT probing in detectProjectServers / isCommandAvailable --
//
// `isCommandAvailable` is private; exercise it via the public
// `detectProjectServers` which calls it for each server with a present root
// marker.

describe("Windows PATHEXT lookup", () => {
	const tempDirs: string[] = [];
	let origPlatform: string;
	let origPath: string | undefined;
	let origPathExt: string | undefined;

	beforeEach(() => {
		origPlatform = process.platform;
		origPath = process.env.PATH;
		origPathExt = process.env.PATHEXT;
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: origPlatform });
		process.env.PATH = origPath;
		if (origPathExt === undefined) {
			delete process.env.PATHEXT;
		} else {
			process.env.PATHEXT = origPathExt;
		}
		for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
		tempDirs.length = 0;
		vi.unstubAllEnvs?.();
	});

	it("finds command via PATHEXT extension on Windows", () => {
		const projectDir = mkdtempSync(join(tmpdir(), "lsp-pathext-proj-"));
		const binDir = mkdtempSync(join(tmpdir(), "lsp-pathext-bin-"));
		tempDirs.push(projectDir, binDir);

		// Project has the root marker but the bare command is NOT on PATH —
		// only `<command>.CMD` is. On Windows, PATHEXT probing should find it.
		writeFileSync(join(projectDir, "tsconfig.json"), "{}");
		writeFileSync(join(binDir, "fake-lsp.CMD"), "@echo off");

		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PATH = binDir;
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

		const config = {
			servers: {
				fake: {
					command: "fake-lsp",
					args: [],
					fileTypes: [".ts"],
					rootMarkers: ["tsconfig.json"],
				},
			},
		};

		expect(detectProjectServers(config, projectDir)).toContain("fake");
	});

	it("does not detect when neither bare nor PATHEXT-suffixed binary exists", () => {
		const projectDir = mkdtempSync(join(tmpdir(), "lsp-pathext-miss-"));
		const binDir = mkdtempSync(join(tmpdir(), "lsp-pathext-empty-"));
		tempDirs.push(projectDir, binDir);

		writeFileSync(join(projectDir, "tsconfig.json"), "{}");
		// binDir intentionally empty

		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PATH = binDir;
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

		const config = {
			servers: {
				fake: {
					command: "missing-lsp",
					args: [],
					fileTypes: [".ts"],
					rootMarkers: ["tsconfig.json"],
				},
			},
		};

		expect(detectProjectServers(config, projectDir)).not.toContain("fake");
	});
});

describe("loadLspConfig", () => {
	it("loads built-in defaults", () => {
		const config = loadLspConfig("/tmp/nonexistent-project");
		expect(Object.keys(config.servers).length).toBeGreaterThan(20);
		expect(config.servers["typescript-language-server"]).toBeDefined();
		expect(config.servers["rust-analyzer"]).toBeDefined();
		expect(config.servers["pyright"]).toBeDefined();
	});
});
