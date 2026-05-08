import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { loadCodeIntelConfig } from "../src/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
	vi.resetAllMocks();
	mockExistsSync.mockReturnValue(false);
});

describe("loadCodeIntelConfig", () => {
	it("returns default config when no config files exist", () => {
		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config).toEqual({
			lsp: { enabled: true },
			agents: { enabled: true },
			prompt: { enabled: true },
			web: { enabled: true },
			context7: { enabled: true },
			analysis: { captureSystemPrompt: true },
		});
	});

	it("reads analysis.captureSystemPrompt from a project config", () => {
		mockExistsSync.mockImplementation((path) =>
			String(path).includes(".pi/code-intel.json") && String(path).startsWith("/fake/cwd"),
		);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ analysis: { captureSystemPrompt: false } }),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.analysis.captureSystemPrompt).toBe(false);
	});

	it("ignores unknown keys inside the analysis section", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ analysis: { captureSystemPrompt: true, mystery: 42 } }),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.analysis).toEqual({ captureSystemPrompt: true });
	});

	it("project config overrides defaults when it exists", () => {
		mockExistsSync.mockImplementation((path) =>
			String(path).includes(".pi/code-intel.json") && String(path).startsWith("/fake/cwd"),
		);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ lsp: { enabled: false } }),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.lsp.enabled).toBe(false);
		expect(config.agents.enabled).toBe(true);
		expect(config.prompt.enabled).toBe(true);
	});

	it("user config is merged before project config", () => {
		// User config disables agents, project config re-enables lsp
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync
			.mockReturnValueOnce(JSON.stringify({ agents: { enabled: false } }))
			.mockReturnValueOnce(JSON.stringify({ lsp: { enabled: false } }));

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.lsp.enabled).toBe(false);
		expect(config.agents.enabled).toBe(false);
		expect(config.prompt.enabled).toBe(true);
	});

	it("returns independent config objects on successive calls", () => {
		const a = loadCodeIntelConfig("/fake/cwd");
		const b = loadCodeIntelConfig("/fake/cwd");

		a.lsp.enabled = false;
		expect(b.lsp.enabled).toBe(true);
	});
});

describe("mergeConfigFile (via loadCodeIntelConfig)", () => {
	it("ignores non-object JSON values", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify(null));

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config).toEqual({
			lsp: { enabled: true },
			agents: { enabled: true },
			prompt: { enabled: true },
			web: { enabled: true },
			context7: { enabled: true },
			analysis: { captureSystemPrompt: true },
		});
	});

	it("ignores unknown top-level keys and preserves defaults", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ unknownKey: { foo: "bar" } }),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config).toEqual({
			lsp: { enabled: true },
			agents: { enabled: true },
			prompt: { enabled: true },
			web: { enabled: true },
			context7: { enabled: true },
			analysis: { captureSystemPrompt: true },
		});
	});

	it("ignores non-object values for known sections", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ lsp: "not-an-object", agents: 42 }),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.lsp.enabled).toBe(true);
		expect(config.agents.enabled).toBe(true);
	});

	it("does not throw on malformed JSON — logs error and returns defaults", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("{ bad json }");

		expect(() => loadCodeIntelConfig("/fake/cwd")).not.toThrow();

		const config = loadCodeIntelConfig("/fake/cwd");
		expect(config).toEqual({
			lsp: { enabled: true },
			agents: { enabled: true },
			prompt: { enabled: true },
			web: { enabled: true },
			context7: { enabled: true },
			analysis: { captureSystemPrompt: true },
		});
	});

	it("merges all sections when all are present", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				lsp: { enabled: false },
				agents: { enabled: false },
				prompt: { enabled: false },
				web: { enabled: false },
				context7: { enabled: false },
			}),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.lsp.enabled).toBe(false);
		expect(config.agents.enabled).toBe(false);
		expect(config.prompt.enabled).toBe(false);
		expect(config.web.enabled).toBe(false);
		expect(config.context7.enabled).toBe(false);
	});

	it("ignores array values for config sections", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ web: [1, 2, 3], context7: "string" }),
		);

		const config = loadCodeIntelConfig("/fake/cwd");

		expect(config.web.enabled).toBe(true);
		expect(config.context7.enabled).toBe(true);
	});
});
