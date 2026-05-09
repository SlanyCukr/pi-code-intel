import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLspTool } from "../../src/lsp/tool.js";

// Minimal mock for LspClientManager
function createMockManager(overrides: Record<string, any> = {}) {
	return {
		getActiveServers: vi.fn(() => []),
		restart: vi.fn(async () => {}),
		getClientForFile: vi.fn(async () => "mock-client"),
		syncFile: vi.fn(async () => {}),
		sendRequest: vi.fn(async () => null),
		getDiagnostics: vi.fn(() => new Map()),
		...overrides,
	} as any;
}

describe("createLspTool", () => {
	it("returns a tool with correct name and label", () => {
		const tool = createLspTool(createMockManager(), "/tmp");
		expect(tool.name).toBe("lsp");
		expect(tool.label).toBe("LSP");
	});

	it("includes all actions in description", () => {
		const tool = createLspTool(createMockManager(), "/tmp");
		expect(tool.description).toContain("definition");
		expect(tool.description).toContain("hover");
		expect(tool.description).toContain("rename");
		expect(tool.description).toContain("status");
		expect(tool.description).toContain("reload");
	});
});

describe("LSP tool execute", () => {
	let manager: ReturnType<typeof createMockManager>;

	beforeEach(() => {
		manager = createMockManager();
	});

	async function exec(input: Record<string, any>) {
		const tool = createLspTool(manager, "/tmp");
		const result = await tool.execute("call-1", input as any, undefined as any, undefined as any, undefined as any);
		const block = result.content[0];
		return block.type === "text" ? block.text : "";
	}

	describe("status action", () => {
		it("reports no servers when none running", async () => {
			const text = await exec({ action: "status" });
			expect(text).toBe("No LSP servers are currently running.");
		});

		it("lists active servers", async () => {
			manager.getActiveServers.mockReturnValue(["typescript", "rust-analyzer"]);
			const text = await exec({ action: "status" });
			expect(text).toContain("typescript");
			expect(text).toContain("rust-analyzer");
		});
	});

	describe("reload action", () => {
		it("calls restart and returns confirmation", async () => {
			const text = await exec({ action: "reload" });
			expect(manager.restart).toHaveBeenCalled();
			expect(text).toContain("shut down");
			expect(text).toContain("re-spawned");
		});
	});

	describe("workspace_symbols action", () => {
		it("throws when query missing", async () => {
			await expect(exec({ action: "workspace_symbols", file: "foo.ts" }))
				.rejects.toThrow("query is required");
		});

		it("throws when file missing", async () => {
			await expect(exec({ action: "workspace_symbols", query: "Foo" }))
				.rejects.toThrow("file is required");
		});

		it("reports no server available", async () => {
			manager.getClientForFile.mockResolvedValue(null);
			const text = await exec({ action: "workspace_symbols", query: "Foo", file: "foo.ts" });
			expect(text).toContain("No LSP server available");
		});
	});

	describe("file-requiring actions", () => {
		it("throws when file is missing", async () => {
			await expect(exec({ action: "definition" }))
				.rejects.toThrow("file is required");
		});

		it("returns error when no server available", async () => {
			manager.getClientForFile.mockResolvedValue(null);
			const text = await exec({ action: "definition", file: "foo.ts" });
			expect(text).toContain("No LSP server available");
		});
	});

	describe("position-requiring actions", () => {
		it("hover throws when line missing", async () => {
			await expect(exec({ action: "hover", file: "foo.ts" }))
				.rejects.toThrow("line is required");
		});

		it("definition throws when line missing", async () => {
			await expect(exec({ action: "definition", file: "foo.ts" }))
				.rejects.toThrow("line is required");
		});

		it("references throws when line missing", async () => {
			await expect(exec({ action: "references", file: "foo.ts" }))
				.rejects.toThrow("line is required");
		});

		it("rename throws when line or new_name missing", async () => {
			await expect(exec({ action: "rename", file: "foo.ts" }))
				.rejects.toThrow("line is required");

			await expect(exec({ action: "rename", file: "foo.ts", line: 1 }))
				.rejects.toThrow("new_name is required");
		});

		it("code_actions throws when line missing", async () => {
			await expect(exec({ action: "code_actions", file: "foo.ts" }))
				.rejects.toThrow("line is required");
		});

		it("incoming_calls throws when line missing", async () => {
			await expect(exec({ action: "incoming_calls", file: "foo.ts" }))
				.rejects.toThrow("line is required");
		});
	});

	describe("definition action", () => {
		it("returns no results when null", async () => {
			manager.sendRequest.mockResolvedValue(null);
			const text = await exec({ action: "definition", file: "foo.ts", line: 1 });
			expect(text).toBe("No results found.");
		});

		it("returns no results for empty array", async () => {
			manager.sendRequest.mockResolvedValue([]);
			const text = await exec({ action: "definition", file: "foo.ts", line: 1 });
			expect(text).toBe("No results found.");
		});
	});

	describe("document_symbols action", () => {
		it("handles null response", async () => {
			manager.sendRequest.mockResolvedValue(null);
			const text = await exec({ action: "document_symbols", file: "foo.ts" });
			expect(text).toContain("No symbols found");
		});
	});

	describe("hover action", () => {
		it("handles null response", async () => {
			manager.sendRequest.mockResolvedValue(null);
			const text = await exec({ action: "hover", file: "foo.ts", line: 1 });
			expect(text).toContain("No hover");
		});
	});

	describe("rename action", () => {
		it("reports rename not supported when null", async () => {
			manager.sendRequest.mockResolvedValue(null);
			const text = await exec({ action: "rename", file: "foo.ts", line: 1, new_name: "bar" });
			expect(text).toBe("Rename not supported at this location.");
		});

		it("counts affected files from changes", async () => {
			manager.sendRequest.mockResolvedValue({
				changes: { "file:///a.ts": [], "file:///b.ts": [] },
			});
			const text = await exec({ action: "rename", file: "foo.ts", line: 1, new_name: "bar" });
			expect(text).toContain("2 file(s)");
		});

		it("counts affected files from documentChanges", async () => {
			manager.sendRequest.mockResolvedValue({
				documentChanges: [{ textDocument: {} }, { textDocument: {} }, { textDocument: {} }],
			});
			const text = await exec({ action: "rename", file: "foo.ts", line: 1, new_name: "bar" });
			expect(text).toContain("3 file(s)");
		});
	});

	describe("code_actions action", () => {
		it("reports no code actions when empty", async () => {
			manager.sendRequest.mockResolvedValue([]);
			const text = await exec({ action: "code_actions", file: "foo.ts", line: 1 });
			expect(text).toBe("No code actions available at this location.");
		});

		it("formats code action list", async () => {
			manager.sendRequest.mockResolvedValue([
				{ title: "Import 'foo'", kind: "quickfix", isPreferred: true },
				{ title: "Extract method", kind: "refactor" },
			]);
			const text = await exec({ action: "code_actions", file: "foo.ts", line: 1 });
			expect(text).toContain("Import 'foo'");
			expect(text).toContain("[quickfix]");
			expect(text).toContain("(preferred)");
			expect(text).toContain("Extract method");
		});
	});

	describe("incoming_calls action", () => {
		it("reports no hierarchy when prepareCallHierarchy returns null", async () => {
			manager.sendRequest.mockResolvedValue(null);
			const text = await exec({ action: "incoming_calls", file: "foo.ts", line: 1 });
			expect(text).toContain("Could not resolve call hierarchy");
		});
	});
});
