import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Mock spawn before importing the module under test so the LSP client uses
// fake processes we can drive deterministically.
const spawnMock = vi.fn();
vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>(
		"node:child_process",
	);
	return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const { LspClientManager, collectSourceFiles } = await import(
	"../../src/lsp/client.js"
);

const TS_EXTS = new Set([".ts"]);

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "lsp-client-test-"));
}

describe("collectSourceFiles", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("finds .ts files recursively", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "index.ts"), "");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "utils.ts"), "");
		mkdirSync(join(root, "src", "nested"));
		writeFileSync(join(root, "src", "nested", "deep.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(3);
		expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("utils.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("deep.ts"))).toBe(true);
	});

	it("does not include non-matching extensions", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "script.ts"), "");
		writeFileSync(join(root, "readme.md"), "");
		writeFileSync(join(root, "data.json"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith("script.ts")).toBe(true);
	});

	it("skips node_modules directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "app.ts"), "");
		mkdirSync(join(root, "node_modules", "lib"), { recursive: true });
		writeFileSync(join(root, "node_modules", "lib", "index.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith("app.ts")).toBe(true);
	});

	it("skips .git directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "main.ts"), "");
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
		writeFileSync(join(root, ".git", "config.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith("main.ts")).toBe(true);
	});

	it("skips dist directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "source.ts"), "");
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "source.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith(join(root, "source.ts"))).toBe(true);
	});

	it("respects maxFiles limit", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		for (let i = 0; i < 10; i++) {
			writeFileSync(join(root, `file${i}.ts`), "");
		}

		const files = collectSourceFiles(root, TS_EXTS, 5);

		expect(files).toHaveLength(5);
	});

	it("returns all files when count is under maxFiles limit", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "a.ts"), "");
		writeFileSync(join(root, "b.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS, 100);

		expect(files).toHaveLength(2);
	});

	it("handles symlink loop protection without infinite recursion", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "real.ts"), "");
		mkdirSync(join(root, "subdir"));

		// Create a symlink that points back to the root — would loop without protection
		try {
			symlinkSync(root, join(root, "subdir", "loop"));
		} catch {
			// Skip if symlink creation fails (e.g., no permissions)
			return;
		}

		// Should complete without hanging or throwing
		const files = collectSourceFiles(root, TS_EXTS);

		expect(files.some((f) => f.endsWith("real.ts"))).toBe(true);
	});

	it("returns empty array for empty directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(0);
	});
});

// -- Exit-handler race regression --
//
// Failure mode (pre-fix): when an LSP init fails and we SIGTERM the child,
// its `exit` event fires asynchronously later. By that time a successful
// retry may have registered a NEW client under the same server name. The
// stale handler used to call `clients.delete(serverName)` unconditionally,
// erasing the new client. The fix is an identity guard.

interface FakeChild extends EventEmitter {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	kill: ReturnType<typeof vi.fn>;
	pid: number;
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	child.pid = Math.floor(Math.random() * 100_000);
	return child;
}

/** Wait for the next LSP `initialize` request written to stdin and return its id. */
function nextInitializeId(stream: PassThrough): Promise<number> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		const timer = setTimeout(
			() => reject(new Error("timed out waiting for initialize request")),
			2000,
		);
		const handler = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const sep = buf.indexOf("\r\n\r\n");
			if (sep === -1) return;
			const header = buf.subarray(0, sep).toString("utf-8");
			const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
			if (!lenMatch) return;
			const len = Number.parseInt(lenMatch[1], 10);
			if (buf.length < sep + 4 + len) return;
			const body = buf.subarray(sep + 4, sep + 4 + len).toString("utf-8");
			try {
				const msg = JSON.parse(body);
				if (msg.method === "initialize" && typeof msg.id === "number") {
					clearTimeout(timer);
					stream.off("data", handler);
					resolve(msg.id);
				}
			} catch {
				/* incomplete; wait for more */
			}
		};
		stream.on("data", handler);
	});
}

function writeLspMessage(stream: PassThrough, payload: unknown): void {
	const body = JSON.stringify(payload);
	const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
	stream.write(header + body);
}

describe("LspClientManager exit-handler race", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("a failed child's late exit does not erase the successor client", async () => {
		const serverConfig = {
			command: "fake-lsp",
			args: [],
			rootMarkers: [],
			fileTypes: [".ts"],
		};
		const config = { servers: { fake: serverConfig } };
		// Unique cwd per test so acquire does not return a singleton from
		// another test run.
		const cwd = `${tmpdir()}/lsp-race-test-${Date.now()}-${Math.random()}`;

		const childA = makeFakeChild();
		const childB = makeFakeChild();
		spawnMock.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
		const manager = LspClientManager.acquire(config as any, cwd);

		try {
			// --- First attempt: init fails ---
			const seenIdA = nextInitializeId(childA.stdin);
			const attemptA = manager
				// biome-ignore lint/suspicious/noExplicitAny: test-only
				.getOrCreate("fake", serverConfig as any)
				.catch((e: unknown) => e);
			await seenIdA;
			// Reject the initialize request by firing exit. The handler removes
			// from clients (no-op since nothing was added) and rejects pendings.
			childA.emit("exit", 1);
			const errA = await attemptA;
			expect(errA).toBeInstanceOf(Error);

			// --- Second attempt: init succeeds ---
			const seenIdB = nextInitializeId(childB.stdin);
			const attemptB = manager.getOrCreate(
				"fake",
				// biome-ignore lint/suspicious/noExplicitAny: test-only
				serverConfig as any,
			);
			const idB = await seenIdB;
			writeLspMessage(childB.stdout, {
				jsonrpc: "2.0",
				id: idB,
				result: { capabilities: {} },
			});
			const clientB = await attemptB;

			expect(manager.getActiveServers()).toContain("fake");

			// --- The race: child A's late exit fires AFTER B is registered ---
			// Without the identity guard this would delete the "fake" entry,
			// stranding child B as an untracked process.
			childA.emit("exit", 137);

			expect(manager.getActiveServers()).toContain("fake");
			// biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
			expect((manager as any).clients.get("fake")).toBe(clientB);

			// Cleanly terminate child B before release() so shutdownClient does
			// not wait 5s for an LSP shutdown response from a fake process.
			childB.emit("exit", 0);
		} finally {
			await manager.release();
		}
	});
});

describe("LspClientManager diagnostics parsing", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("filters malformed diagnostics from publishDiagnostics notifications", async () => {
		const serverConfig = {
			command: "fake-lsp",
			args: [],
			rootMarkers: [],
			fileTypes: [".ts"],
		};
		const config = { servers: { fake: serverConfig } };
		const cwd = `${tmpdir()}/lsp-diagnostics-test-${Date.now()}-${Math.random()}`;
		const child = makeFakeChild();
		spawnMock.mockReturnValueOnce(child);
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
		const manager = LspClientManager.acquire(config as any, cwd);

		try {
			const seenId = nextInitializeId(child.stdin);
			const client = manager.getOrCreate(
				"fake",
				// biome-ignore lint/suspicious/noExplicitAny: test-only
				serverConfig as any,
			);
			const id = await seenId;
			writeLspMessage(child.stdout, {
				jsonrpc: "2.0",
				id,
				result: { capabilities: {} },
			});
			const lspClient = await client;

			writeLspMessage(child.stdout, {
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: "file:///tmp/example.ts",
					diagnostics: [
						{
							range: {
								start: { line: 1, character: 2 },
								end: { line: 1, character: 5 },
							},
							message: "valid diagnostic",
							severity: 1,
						},
						{ message: "missing range" },
						{
							range: {
								start: { line: "bad", character: 0 },
								end: { line: 1, character: 5 },
							},
							message: "bad position",
						},
					],
				},
			});

			const diagnostics = manager.getDiagnostics(lspClient);
			expect(diagnostics.get("file:///tmp/example.ts")).toEqual([
				expect.objectContaining({ message: "valid diagnostic" }),
			]);
			child.emit("exit", 0);
		} finally {
			await manager.release();
		}
	});
});
