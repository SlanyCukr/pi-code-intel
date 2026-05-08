import { describe, it, expect, vi, beforeEach } from "vitest";
import { Context7Client } from "../../src/web/context7.js";
import { EventEmitter } from "node:events";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

/** Create a mock child process with stdin/stdout/stderr as EventEmitters. */
function createMockProcess() {
	const stdin = { write: vi.fn(), writable: true };
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const proc = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		stderr,
		kill: vi.fn(),
		pid: 12345,
	});
	return proc;
}

/** Build a newline-delimited JSON-RPC message (MCP stdio framing). */
function frameMessage(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

/** Wait until the mock has been called at least `n` times. */
async function waitForWrite(
	mock: ReturnType<typeof vi.fn>,
	n: number,
	timeoutMs = 1000,
): Promise<void> {
	const start = Date.now();
	while (mock.mock.calls.length < n) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timed out waiting for write call #${n} (got ${mock.mock.calls.length})`);
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("Context7Client", () => {
	it("starts the MCP server and completes the initialize handshake", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// The client should have sent the initialize request
		expect(proc.stdin.write).toHaveBeenCalled();
		const written = proc.stdin.write.mock.calls[0][0] as string;
		expect(written).toContain('"method":"initialize"');

		// Simulate server response with the initialize result
		const initRequest = JSON.parse(written);
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({
					jsonrpc: "2.0",
					id: initRequest.id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "context7-mcp", version: "1.0.0" },
					},
				}),
			),
		);

		await startPromise;

		// Should have also sent the initialized notification
		expect(proc.stdin.write).toHaveBeenCalledTimes(2);
		const notif = proc.stdin.write.mock.calls[1][0] as string;
		expect(notif).toContain('"method":"notifications/initialized"');

		client.stop();
	});

	it("calls tools via JSON-RPC", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Complete init handshake
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} }),
			),
		);
		await startPromise;

		// Call a tool
		const toolPromise = client.callTool("resolve-library-id", {
			libraryName: "express",
		});

		// Wait for the tool call write to appear
		await waitForWrite(proc.stdin.write, 3);
		const toolWritten = proc.stdin.write.mock.calls[2][0] as string;
		const toolReq = JSON.parse(toolWritten);
		expect(toolReq.method).toBe("tools/call");
		expect(toolReq.params.name).toBe("resolve-library-id");

		// Simulate response
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({
					jsonrpc: "2.0",
					id: toolReq.id,
					result: {
						content: [
							{
								type: "text",
								text: "Context7-compatible library ID: /npm/express",
							},
						],
					},
				}),
			),
		);

		const result = await toolPromise;
		expect(result).toEqual({
			content: [
				{ type: "text", text: "Context7-compatible library ID: /npm/express" },
			],
		});

		client.stop();
	});

	it("rejects pending requests when process exits", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Complete init
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} })),
		);
		await startPromise;

		// Start a tool call that will never get a response
		const toolPromise = client.callTool("resolve-library-id", {
			libraryName: "express",
		});

		// Wait for the write, then kill the process
		await waitForWrite(proc.stdin.write, 3);
		proc.emit("exit", 1);

		await expect(toolPromise).rejects.toThrow("exited with code 1");
	});

	it("resolves library name from Context7 response", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Complete init
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} })),
		);
		await startPromise;

		// Call resolveLibrary. The new signature requires both `name` and a
		// `query` topic so the server can rank by relevance.
		const resolvePromise = client.resolveLibrary("express", "middleware");

		// Wait for the tool call write, then respond
		await waitForWrite(proc.stdin.write, 3);
		const toolWritten = proc.stdin.write.mock.calls[2][0] as string;
		const toolReq = JSON.parse(toolWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({
					jsonrpc: "2.0",
					id: toolReq.id,
					result: {
						content: [
							{
								type: "text",
								text: "Context7-compatible library ID: /npm/express\nDescription: Express web framework",
							},
						],
					},
				}),
			),
		);

		const libraryId = await resolvePromise;
		expect(libraryId).toBe("/npm/express");

		client.stop();
	});

	it("returns null when library is not found", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Complete init
		await waitForWrite(proc.stdin.write, 1);
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} })),
		);
		await startPromise;

		const resolvePromise = client.resolveLibrary("nonexistent-lib", "any");

		// Wait for the tool call write to appear (after init + notification)
		await waitForWrite(proc.stdin.write, 3);
		const toolWritten = proc.stdin.write.mock.calls[2][0] as string;
		const toolReq = JSON.parse(toolWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({
					jsonrpc: "2.0",
					id: toolReq.id,
					result: { content: [{ type: "text", text: "No libraries found" }] },
				}),
			),
		);

		const libraryId = await resolvePromise;
		expect(libraryId).toBeNull();

		client.stop();
	});

	it("stop kills the process and rejects pending requests", () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		// Manually set up the process (simulating a started state)
		(client as any).process = proc;
		(client as any).initialized = true;

		// Add a pending request
		let rejected = false;
		(client as any).pending.set(1, {
			resolve: () => {},
			reject: () => { rejected = true; },
		});

		client.stop();

		expect(proc.kill).toHaveBeenCalled();
		expect(rejected).toBe(true);
	});

	it("rejects with error when server returns JSON-RPC error", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Complete init
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} })),
		);
		await startPromise;

		// Call a tool
		const toolPromise = client.callTool("resolve-library-id", { libraryName: "express" });

		await waitForWrite(proc.stdin.write, 3);
		const toolWritten = proc.stdin.write.mock.calls[2][0] as string;
		const toolReq = JSON.parse(toolWritten);

		// Send error response
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({
					jsonrpc: "2.0",
					id: toolReq.id,
					error: { code: -32600, message: "Rate limit exceeded" },
				}),
			),
		);

		await expect(toolPromise).rejects.toThrow("Rate limit exceeded");
		client.stop();
	});

	it("handles split messages across multiple data events", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Send the init response split across two chunks
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		const fullMsg = frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} });
		const midpoint = Math.floor(fullMsg.length / 2);

		proc.stdout.emit("data", Buffer.from(fullMsg.slice(0, midpoint)));
		proc.stdout.emit("data", Buffer.from(fullMsg.slice(midpoint)));

		await startPromise;
		client.stop();
	});

	it("handles multiple messages in a single data event", async () => {
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();

		// Complete init handshake
		const initWritten = proc.stdin.write.mock.calls[0][0] as string;
		const initReq = JSON.parse(initWritten);
		proc.stdout.emit(
			"data",
			Buffer.from(frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} })),
		);
		await startPromise;

		// Start two tool calls
		const call1 = client.callTool("tool-a", {});
		const call2 = client.callTool("tool-b", {});

		await waitForWrite(proc.stdin.write, 4); // init + notification + 2 tool calls
		const req1 = JSON.parse((proc.stdin.write.mock.calls[2][0] as string));
		const req2 = JSON.parse((proc.stdin.write.mock.calls[3][0] as string));

		// Send both responses in a single chunk
		const msg1 = frameMessage({ jsonrpc: "2.0", id: req1.id, result: { data: "a" } });
		const msg2 = frameMessage({ jsonrpc: "2.0", id: req2.id, result: { data: "b" } });
		proc.stdout.emit("data", Buffer.from(msg1 + msg2));

		const [result1, result2] = await Promise.all([call1, call2]);
		expect(result1).toEqual({ data: "a" });
		expect(result2).toEqual({ data: "b" });

		client.stop();
	});

	it("ignores stale exit/error events from a previous process", async () => {
		// Regression: without identity-guarded handlers, a late `exit` from the
		// killed first process would falsely mark the freshly-started second
		// process as uninitialized and reject its pending requests.
		const proc1 = createMockProcess();
		const proc2 = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

		const client = new Context7Client();
		const start1 = client.start();
		const initReq1 = JSON.parse(
			(proc1.stdin.write.mock.calls[0][0] as string),
		);
		proc1.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({ jsonrpc: "2.0", id: initReq1.id, result: {} }),
			),
		);
		await start1;

		// Tear down and restart — second process now owns the client.
		client.stop();
		const start2 = client.start();
		const initReq2 = JSON.parse(
			(proc2.stdin.write.mock.calls[0][0] as string),
		);
		proc2.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({ jsonrpc: "2.0", id: initReq2.id, result: {} }),
			),
		);
		await start2;

		// In-flight call against the new process.
		const toolCall = client.callTool("tool-x", {});
		await waitForWrite(proc2.stdin.write, 3);

		// Late exit event from the OLD process — must be ignored.
		proc1.emit("exit", 137);

		const toolReq = JSON.parse(
			(proc2.stdin.write.mock.calls[2][0] as string),
		);
		proc2.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({ jsonrpc: "2.0", id: toolReq.id, result: { ok: true } }),
			),
		);

		await expect(toolCall).resolves.toEqual({ ok: true });
		client.stop();
	});

	it("tears down the process when an oversized line arrives without a newline", async () => {
		// Regression: a compromised MCP server streaming gigabytes without ever
		// emitting a newline must not drive the parse buffer to OOM. The cap is
		// enforced on the unframed buffer and triggers stop() once exceeded.
		const proc = createMockProcess();
		mockSpawn.mockReturnValueOnce(proc as any);

		const client = new Context7Client();
		const startPromise = client.start();
		const initReq = JSON.parse(
			(proc.stdin.write.mock.calls[0][0] as string),
		);
		proc.stdout.emit(
			"data",
			Buffer.from(
				frameMessage({ jsonrpc: "2.0", id: initReq.id, result: {} }),
			),
		);
		await startPromise;

		const pending = client.callTool("any", {});
		await waitForWrite(proc.stdin.write, 3);

		// Stream 11 MB without a newline — exceeds MAX_FRAME_BYTES (10 MB).
		const CHUNK = 1024 * 1024;
		for (let i = 0; i < 11; i++) {
			proc.stdout.emit(
				"data",
				Buffer.alloc(CHUNK, 0x78), // 'x' bytes, no newline
			);
			if (proc.kill.mock.calls.length > 0) break;
		}

		expect(proc.kill).toHaveBeenCalled();
		await expect(pending).rejects.toThrow(/stopped/);
	});
});
