import { spawn, type ChildProcess } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import type {
	AgentToolResult,
	ToolDefinition,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export const CONTEXT7_TOOL_NAME = "context7";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Defense-in-depth bound on a single inbound message line. The MCP child
// process is trusted on the happy path, but a compromised package could
// stream gigabytes without ever sending a newline; without a cap we would
// accumulate the entire stream into the parse buffer until OOM. Library
// doc responses are well under this size in practice.
const MAX_FRAME_BYTES = 10 * 1024 * 1024; // 10MB

// -- JSON-RPC over stdio (MCP protocol) --

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	id: number;
	result: unknown;
}

interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: number;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

/**
 * Pinned Context7 MCP server version.
 *
 * The Context7 server's tool surface drifted in 2.2.x (`get-library-docs`
 * was renamed to `query-docs`, the resolve tool gained a required `query`
 * parameter). An unpinned `npx -y @upstash/context7-mcp` would silently
 * pull whatever ships next — a breaking change in any future minor would
 * take this extension dark with no signal until a user noticed.
 *
 * `^2.2.4` accepts patches (security/bug fixes) and future 2.x minors but
 * refuses 3.0.0+. The MCP smoke test in CI is responsible for catching
 * any drift within the accepted range; if it fails, tighten this pin.
 */
const CONTEXT7_MCP_VERSION = "^2.2.4";
const CONTEXT7_MCP_PACKAGE = `@upstash/context7-mcp@${CONTEXT7_MCP_VERSION}`;

/**
 * Lightweight MCP stdio client for Context7.
 *
 * Spawns `npx -y @upstash/context7-mcp@<pinned>` and communicates via
 * JSON-RPC over stdin/stdout. MCP framing is newline-delimited JSON (one
 * message per line) — NOT LSP-style `Content-Length`. See `processBuffer`
 * for the framing details.
 *
 * Server-initiated notifications (messages without an `id`) are ignored —
 * this client only uses request/response pairs.
 */
export class Context7Client {
	private process: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private buffer = Buffer.alloc(0);
	private initialized = false;
	private startPromise: Promise<void> | null = null;

	/**
	 * Start the Context7 MCP server process.
	 * Lazy — called automatically on first tool invocation.
	 */
	async start(): Promise<void> {
		if (this.initialized) return;
		if (this.startPromise) return this.startPromise;

		this.startPromise = this._start();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	private async _start(): Promise<void> {
		const proc = spawn("npx", ["-y", CONTEXT7_MCP_PACKAGE], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		this.process = proc;

		// Each handler captures the spawned process identity. After stop()+start(),
		// the old process's late `exit`/`error`/`data` events would otherwise mutate
		// the new client state — falsely marking it uninitialized, rejecting its
		// pending requests, or concatenating stale stdout into the new buffer.
		// Same identity-guard pattern as LspClientManager.spawnAndInitialize.
		proc.stdout!.on("data", (chunk: Buffer) => {
			if (this.process !== proc) return;
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.processBuffer();
		});

		proc.stderr!.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8").trim();
			if (text) {
				console.error(`[context7] ${text}`);
			}
		});

		proc.on("error", (err) => {
			console.error(`[context7] Failed to spawn process: ${err.message}`);
			if (this.process !== proc) return;
			this.initialized = false;
			for (const [, req] of this.pending) {
				req.reject(new Error(`Context7 process failed to start: ${err.message}`));
			}
			this.pending.clear();
			this.process = null;
		});

		proc.on("exit", (code) => {
			console.error(`[context7] Process exited with code ${code}`);
			if (this.process !== proc) return;
			this.initialized = false;
			// Reject all pending requests
			for (const [, req] of this.pending) {
				req.reject(new Error(`Context7 process exited with code ${code}`));
			}
			this.pending.clear();
			this.process = null;
		});

		// MCP initialize handshake — clean up process on failure to prevent leaks
		try {
			await this.sendRequest("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-code-intel", version: "0.1.0" },
			}, 60_000).promise; // 60s timeout: npx may need to download the package on first run
		} catch (err) {
			this.stop();
			throw new Error(
				`Failed to initialize Context7 MCP server: ${err instanceof Error ? err.message : err}. ` +
				`Ensure 'npx -y ${CONTEXT7_MCP_PACKAGE}' can run successfully.`,
			);
		}

		// Send initialized notification (no response expected)
		if (!this.process?.stdin?.writable) {
			this.stop();
			throw new Error("Context7 process stdin closed during initialization");
		}
		this.sendNotification("notifications/initialized", {});

		this.initialized = true;
	}

	/**
	 * Process buffered stdout data, extracting complete JSON-RPC messages.
	 *
	 * MCP stdio transport uses NEWLINE-DELIMITED JSON (one message per line),
	 * not LSP's `Content-Length` framing. Messages must not contain embedded
	 * newlines. Buffer is binary to correctly handle multi-byte UTF-8
	 * sequences when slicing on `\n`.
	 */
	private processBuffer(): void {
		while (true) {
			const newlineIdx = this.buffer.indexOf(0x0a); // '\n'
			if (newlineIdx === -1) {
				// No complete line yet. If unframed bytes exceed the cap, treat
				// as bogus framing — a server that never produces a newline can
				// otherwise drive us to OOM.
				if (this.buffer.length > MAX_FRAME_BYTES) {
					console.error(
						`[context7] Inbound line exceeds ${MAX_FRAME_BYTES} bytes with no newline; tearing down process`,
					);
					this.stop();
					return;
				}
				break;
			}

			const lineBytes = this.buffer.subarray(0, newlineIdx);
			this.buffer = this.buffer.subarray(newlineIdx + 1);

			if (lineBytes.length > MAX_FRAME_BYTES) {
				console.error(
					`[context7] Inbound line ${lineBytes.length} bytes exceeds cap ${MAX_FRAME_BYTES}; tearing down process`,
				);
				this.stop();
				return;
			}

			const line = lineBytes.toString("utf-8").trim();
			if (!line) continue; // tolerate stray blank lines

			try {
				const msg = JSON.parse(line) as JsonRpcResponse;
				if (msg.id !== undefined) {
					const pending = this.pending.get(msg.id);
					if (pending) {
						this.pending.delete(msg.id);
						if ("error" in msg) {
							pending.reject(new Error(`Context7 error: ${msg.error.message}`));
						} else {
							pending.resolve(msg.result);
						}
					}
				}
			} catch (err) {
				console.error(
					`[context7] Failed to parse JSON-RPC line (${line.length} bytes). Preview: ${line.slice(0, 200)}`,
					err instanceof Error ? err.message : err,
				);
				// Attempt to extract id to reject the pending request rather than letting it hang.
				const idMatch = line.match(/"id"\s*:\s*(\d+)/);
				if (idMatch) {
					const id = Number.parseInt(idMatch[1]);
					const pending = this.pending.get(id);
					if (pending) {
						this.pending.delete(id);
						pending.reject(new Error("Context7: received malformed JSON-RPC line"));
					}
				}
			}
		}
	}

	/** Send a JSON-RPC request and wait for the response. Returns both the promise and the request ID. */
	private sendRequest(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): { id: number; promise: Promise<unknown> } {
		if (!this.process?.stdin?.writable) {
			return { id: -1, promise: Promise.reject(new Error("Context7 process not running")) };
		}

		const id = this.nextId++;
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			params,
		};

		// MCP stdio framing: one JSON message per line. JSON.stringify never
		// emits raw newlines, so a single trailing `\n` is sufficient.
		const body = JSON.stringify(request);

		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Context7 request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: (value) => { clearTimeout(timer); resolve(value); },
				reject: (reason) => { clearTimeout(timer); reject(reason); },
			});
			this.process!.stdin!.write(`${body}\n`);
		});

		return { id, promise };
	}

	/** Send a JSON-RPC notification (no response expected). */
	private sendNotification(method: string, params?: unknown): void {
		if (!this.process?.stdin?.writable) {
			console.error(`[context7] Cannot send notification ${method}: process stdin not writable`);
			return;
		}

		const notification = { jsonrpc: "2.0", method, params };
		const body = JSON.stringify(notification);
		this.process.stdin.write(`${body}\n`);
	}

	/** Call an MCP tool by name. */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		await this.start();

		// Reject early if already aborted
		if (signal?.aborted) {
			throw new Error("Context7 call aborted");
		}

		const { id, promise: resultPromise } = this.sendRequest("tools/call", { name, arguments: args });

		if (!signal) return resultPromise;

		// Race the request against the abort signal, cleaning up the pending entry on abort
		return new Promise<unknown>((resolve, reject) => {
			const handler = () => {
				// Clean up the pending entry and its timer to prevent leaks
				const pending = this.pending.get(id);
				if (pending) {
					this.pending.delete(id);
					pending.reject(new Error("Context7 call aborted"));
				}
				reject(new Error("Context7 call aborted"));
			};
			signal.addEventListener("abort", handler, { once: true });
			resultPromise
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", handler));
		});
	}

	/**
	 * Resolve a library name to a Context7-compatible library ID.
	 *
	 * The Context7 `resolve-library-id` tool requires both a `libraryName`
	 * (used for matching) and a `query` (used for ranking). The query is the
	 * topic the caller will eventually pass to `queryDocs` so the server
	 * can rank libraries by relevance.
	 */
	async resolveLibrary(
		name: string,
		query: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		const result = (await this.callTool(
			"resolve-library-id",
			{ libraryName: name, query },
			signal,
		)) as {
			content?: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};

		if (result?.isError) {
			const errText = result.content?.find((c) => c.type === "text")?.text;
			throw new Error(
				`Context7 resolve-library-id failed: ${errText ?? "unknown error"}`,
			);
		}

		const text = result?.content?.find((c) => c.type === "text")?.text;
		if (!text) return null;

		// Parse the response — Context7 returns a list of matching libraries.
		// Each entry has a `Context7-compatible library ID: /org/project` line.
		// The first match is the highest-ranked one.
		const lines = text.split("\n").filter((l) => l.trim());
		for (const line of lines) {
			const match =
				line.match(/Context7-compatible library ID:\s*(\S+)/i) ??
				line.match(/\/\w+\/[\w.-]+/);
			if (match) return match[1] ?? match[0];
		}

		return null;
	}

	/**
	 * Query documentation for a specific library and topic.
	 *
	 * Uses the Context7 `query-docs` tool (renamed from the older
	 * `get-library-docs`). Parameters: `libraryId` (e.g. `/vitest-dev/vitest`)
	 * and `query` (the actual question/topic).
	 */
	async queryDocs(
		libraryId: string,
		query: string,
		signal?: AbortSignal,
	): Promise<string> {
		const result = (await this.callTool(
			"query-docs",
			{ libraryId, query },
			signal,
		)) as {
			content?: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};

		if (result?.isError) {
			const errText = result.content?.find((c) => c.type === "text")?.text;
			throw new Error(
				`Context7 query-docs failed: ${errText ?? "unknown error"}`,
			);
		}

		const text = result?.content?.find((c) => c.type === "text")?.text;
		return text ?? "No documentation found.";
	}

	/** Stop the Context7 process. */
	stop(): void {
		if (this.process) {
			try {
				this.process.kill();
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ESRCH") {
					console.error(`[context7] Failed to kill process:`, err instanceof Error ? err.message : err);
				}
			}
			this.process = null;
			this.initialized = false;
			this.buffer = Buffer.alloc(0);
			for (const [, req] of this.pending) {
				req.reject(new Error("Context7 client stopped"));
			}
			this.pending.clear();
		}
	}
}

// -- Tool definition --

const context7Schema = Type.Object(
	{
		library: Type.String({
			description:
				"The library/package name to look up (e.g., 'express', 'react', 'vitest', 'langchain').",
		}),
		topic: Type.String({
			description:
				"What to look up in the library docs. Be specific — e.g., 'route middleware configuration' rather than 'routing'.",
		}),
	},
	{ additionalProperties: false },
);

type Context7Input = Static<typeof context7Schema>;

/**
 * Create the Context7 library documentation tool.
 *
 * Returns both the tool definition and the client instance
 * (so extension.ts can clean up the client on shutdown).
 */
export function createContext7Tool(): {
	tool: ToolDefinition<typeof context7Schema>;
	client: Context7Client;
} {
	const client = new Context7Client();

	const tool: ToolDefinition<typeof context7Schema> = {
		name: CONTEXT7_TOOL_NAME,
		label: "Context7",
		description:
			"Look up version-specific library documentation and code examples. Resolves library name, then queries relevant documentation.",
		parameters: context7Schema,
		async execute(
			_toolCallId: string,
			input: Context7Input,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			onUpdate?.({
				content: [{ type: "text" as const, text: `Looking up ${input.library} docs...` }],
				details: undefined,
			});

			// Step 1: Resolve library. Context7's resolve-library-id tool needs
			// both the library name (for matching) and the topic (for ranking),
			// so the most-relevant library for the topic is returned first.
			const libraryId = await client.resolveLibrary(input.library, input.topic, signal);
			if (!libraryId) {
				throw new Error(
					`Could not find library "${input.library}" in Context7. Try a more specific package name (e.g., npm package name).`,
				);
			}

			onUpdate?.({
				content: [
					{
						type: "text" as const,
						text: `Found ${libraryId}, querying docs for "${input.topic}"...`,
					},
				],
				details: undefined,
			});

			// Step 2: Query docs
			const docs = await client.queryDocs(libraryId, input.topic, signal);

			return {
				content: [{ type: "text" as const, text: docs }],
				details: undefined,
			};
		},
	};

	return { tool, client };
}
