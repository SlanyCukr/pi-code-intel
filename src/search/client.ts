import type { ChildProcess } from "node:child_process";

/**
 * Thin MCP JSON-RPC client over stdio.
 *
 * MCP uses newline-delimited JSON-RPC (NOT Content-Length headers like LSP).
 */
export class McpClient {
	private process: ChildProcess;
	private nextId = 1;
	private pendingRequests = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer?: ReturnType<typeof setTimeout>;
		}
	>();
	private buffer = "";
	private ready = false;

	constructor(process: ChildProcess) {
		this.process = process;
		this.startReader();
	}

	private startReader(): void {
		const stdout = this.process.stdout;
		if (!stdout) return;

		stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			this.processBuffer();
		});

		this.process.on("exit", () => {
			for (const [, req] of this.pendingRequests) {
				if (req.timer) clearTimeout(req.timer);
				req.reject(new Error("MCP process exited"));
			}
			this.pendingRequests.clear();
		});
	}

	private processBuffer(): void {
		const lines = this.buffer.split("\n");
		// Keep the last incomplete line in the buffer
		this.buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const message = JSON.parse(trimmed);
				this.handleMessage(message);
			} catch {
				// Skip malformed JSON
			}
		}
	}

	private handleMessage(message: {
		id?: number;
		result?: unknown;
		error?: { code: number; message: string };
		method?: string;
	}): void {
		if (message.id !== undefined && !message.method) {
			// Response to our request
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				this.pendingRequests.delete(message.id);
				if (pending.timer) clearTimeout(pending.timer);

				if (message.error) {
					pending.reject(
						new Error(
							`MCP error ${message.error.code}: ${message.error.message}`,
						),
					);
				} else {
					pending.resolve(message.result);
				}
			}
		}
	}

	/**
	 * Send the MCP initialize handshake.
	 */
	async initialize(timeoutMs = 10_000): Promise<void> {
		await this.request(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-code-intel", version: "0.1.0" },
			},
			timeoutMs,
		);

		// Send initialized notification
		this.notify("notifications/initialized", {});
		this.ready = true;
	}

	/**
	 * Call an MCP tool.
	 */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
		if (!this.ready) {
			throw new Error("MCP client not initialized");
		}

		const result = (await this.request(
			"tools/call",
			{ name, arguments: args },
			timeoutMs,
			signal,
		)) as { content: Array<{ type: string; text: string }>; isError?: boolean };

		return result;
	}

	private request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Request aborted"));
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const abortHandler = () => {
				this.pendingRequests.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", abortHandler);
				reject(new Error("Request aborted"));
			};

			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				signal?.removeEventListener("abort", abortHandler);
				reject(
					new Error(
						`MCP request ${method} timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			signal?.addEventListener("abort", abortHandler, { once: true });

			this.pendingRequests.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abortHandler);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", abortHandler);
					reject(error);
				},
				timer,
			});

			const message = JSON.stringify({
				jsonrpc: "2.0",
				id,
				method,
				params,
			});

			const stdin = this.process.stdin;
			if (stdin && !stdin.destroyed) {
				stdin.write(message + "\n");
			} else {
				this.pendingRequests.delete(id);
				clearTimeout(timer);
				reject(new Error("MCP process stdin not available"));
			}
		});
	}

	private notify(method: string, params: unknown): void {
		const message = JSON.stringify({
			jsonrpc: "2.0",
			method,
			params,
		});

		const stdin = this.process.stdin;
		if (stdin && !stdin.destroyed) {
			stdin.write(message + "\n");
		}
	}
}
