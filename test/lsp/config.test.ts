import { describe, it, expect } from "vitest";
import { getServersForFile, loadLspConfig } from "../../src/lsp/config.js";
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

	it("matches by extension from full paths", () => {
		const result = getServersForFile(
			config,
			"/home/user/project/src/main.ts",
		);
		expect(result.length).toBe(2);
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
