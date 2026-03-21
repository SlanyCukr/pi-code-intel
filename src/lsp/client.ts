import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type LspConfiguration,
	getServersForFile,
	resolveCommand,
} from "./config.js";
import type {
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
	LspClient,
	ServerConfig,
} from "./types.js";
import { fileToUri, getLanguageId } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
			didSave: true,
		},
		hover: {
			dynamicRegistration: false,
			contentFormat: ["markdown", "plaintext"],
		},
		definition: { dynamicRegistration: false },
		typeDefinition: { dynamicRegistration: false },
		implementation: { dynamicRegistration: false },
		references: { dynamicRegistration: false },
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
					],
				},
			},
		},
		rename: { dynamicRegistration: false, prepareSupport: true },
		callHierarchy: { dynamicRegistration: false },
		publishDiagnostics: {
			relatedInformation: true,
			tagSupport: { valueSet: [1, 2] },
		},
	},
	workspace: {
		workspaceFolders: true,
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
		},
		symbol: { dynamicRegistration: false },
	},
};

export class LspClientManager {
	private clients = new Map<string, LspClient>();
	private initializing = new Map<string, Promise<LspClient>>();
	private config: LspConfiguration;
	private cwd: string;
	private idleTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: LspConfiguration, cwd: string) {
		this.config = config;
		this.cwd = cwd;
		this.startIdleChecker();
	}

	/**
	 * Get or create an LSP client for a file.
	 * Returns the first non-linter server that handles the file's extension.
	 */
	async getClientForFile(
		filePath: string,
		signal?: AbortSignal,
	): Promise<LspClient | null> {
		const absPath = resolve(this.cwd, filePath);
		const servers = getServersForFile(this.config, absPath);
		if (servers.length === 0) return null;

		// Use first non-linter server
		const server = servers.find((s) => !s.config.isLinter) ?? servers[0];
		return this.getOrCreate(server.name, server.config, signal);
	}

	/**
	 * Get or create an LSP client by server name.
	 */
	async getOrCreate(
		serverName: string,
		serverConfig: ServerConfig,
		signal?: AbortSignal,
	): Promise<LspClient> {
		// Already running
		const existing = this.clients.get(serverName);
		if (existing) {
			existing.lastUsed = Date.now();
			return existing;
		}

		// Already initializing — wait for it
		const pending = this.initializing.get(serverName);
		if (pending) return pending;

		// Create new
		const promise = this.spawnAndInitialize(serverName, serverConfig, signal);
		this.initializing.set(serverName, promise);

		try {
			const client = await promise;
			this.clients.set(serverName, client);
			return client;
		} finally {
			this.initializing.delete(serverName);
		}
	}

	private async spawnAndInitialize(
		serverName: string,
		serverConfig: ServerConfig,
		signal?: AbortSignal,
	): Promise<LspClient> {
		const resolved = resolveCommand(serverConfig, this.cwd);

		const child = spawn(resolved.command, resolved.args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...resolved.env },
		});

		const client: LspClient = {
			serverName,
			config: serverConfig,
			process: child,
			serverCapabilities: {},
			openFiles: new Map(),
			pendingRequests: new Map(),
			diagnostics: new Map(),
			lastUsed: Date.now(),
			nextId: 1,
			buffer: Buffer.alloc(0),
		};

		// Start reading responses
		this.startMessageReader(client);

		// Handle process exit
		child.on("exit", (code) => {
			// Reject all pending requests
			for (const [, req] of client.pendingRequests) {
				if (req.timer) clearTimeout(req.timer);
				req.reject(
					new Error(
						`LSP server ${serverName} exited with code ${code}`,
					),
				);
			}
			client.pendingRequests.clear();
			this.clients.delete(serverName);
		});

		child.on("error", (err) => {
			for (const [, req] of client.pendingRequests) {
				if (req.timer) clearTimeout(req.timer);
				req.reject(err);
			}
			client.pendingRequests.clear();
			this.clients.delete(serverName);
		});

		// Send initialize request — kill child if init fails
		try {
			const initResult = (await this.sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					capabilities: CLIENT_CAPABILITIES,
					rootUri: fileToUri(this.cwd),
					rootPath: this.cwd,
					workspaceFolders: [
						{ uri: fileToUri(this.cwd), name: this.cwd.split("/").pop() },
					],
					initializationOptions: serverConfig.initOptions ?? {},
				},
				signal,
				30_000, // Longer timeout for init
			)) as { capabilities: Record<string, unknown> };

			client.serverCapabilities = initResult?.capabilities ?? {};
		} catch (err) {
			child.kill("SIGTERM");
			throw err;
		}

		// Send initialized notification
		this.sendNotification(client, "initialized", {});

		// Send workspace/didChangeConfiguration if settings exist
		if (serverConfig.settings) {
			this.sendNotification(client, "workspace/didChangeConfiguration", {
				settings: serverConfig.settings,
			});
		}

		return client;
	}

	private startMessageReader(client: LspClient): void {
		const stdout = client.process.stdout;
		if (!stdout) return;

		stdout.on("data", (chunk: Buffer) => {
			client.buffer = Buffer.concat([client.buffer, chunk]);
			this.processBuffer(client);
		});
	}

	private static readonly HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

	private processBuffer(client: LspClient): void {
		while (true) {
			// Find Content-Length header end
			const headerEnd = client.buffer.indexOf(LspClientManager.HEADER_SEPARATOR);
			if (headerEnd === -1) break;

			const header = client.buffer.subarray(0, headerEnd).toString("utf-8");
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				// Skip malformed header
				client.buffer = client.buffer.subarray(headerEnd + 4);
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;

			if (client.buffer.length < bodyEnd) {
				// Not enough data yet (byte-length comparison)
				break;
			}

			const body = client.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
			client.buffer = Buffer.from(client.buffer.subarray(bodyEnd));

			try {
				const message = JSON.parse(body);
				this.handleMessage(client, message);
			} catch {
				// Malformed JSON — skip
			}
		}
	}

	private handleMessage(
		client: LspClient,
		message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest,
	): void {
		// Response to a request we sent
		if ("id" in message && message.id !== undefined && !("method" in message)) {
			const response = message as JsonRpcResponse;
			const pending = client.pendingRequests.get(response.id);
			if (pending) {
				client.pendingRequests.delete(response.id);
				if (pending.timer) clearTimeout(pending.timer);
				if (response.error) {
					pending.reject(
						new Error(
							`LSP error ${response.error.code}: ${response.error.message}`,
						),
					);
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		if (!("method" in message)) return;

		// Server request (has both method and id)
		if ("id" in message && message.id !== undefined) {
			const request = message as JsonRpcRequest;
			this.handleServerRequest(client, request);
			return;
		}

		// Server notification (has method but no id)
		const notification = message as JsonRpcNotification;
		if (notification.method === "textDocument/publishDiagnostics") {
			const params = notification.params as {
				uri?: string;
				diagnostics?: unknown[];
			} | null;
			if (params?.uri && Array.isArray(params.diagnostics)) {
				client.diagnostics.set(
					params.uri,
					params.diagnostics as import("./types.js").Diagnostic[],
				);
			}
		}
	}

	private handleServerRequest(client: LspClient, request: JsonRpcRequest): void {
		try {
			if (request.method === "workspace/configuration") {
				const params = request.params as {
					items?: { section?: string }[];
				} | null;
				const items = params?.items ?? [];
				const results = items.map((item) => {
					if (item.section && client.config.settings) {
						return (
							this.getSettingsSection(
								client.config.settings,
								item.section,
							) ?? {}
						);
					}
					return {};
				});
				this.sendResponse(client, request.id, results);
			} else if (request.method === "window/workDoneProgress/create") {
				this.sendResponse(client, request.id, null);
			} else if (request.method === "client/registerCapability") {
				this.sendResponse(client, request.id, null);
			}
		} catch {
			// Respond with empty result to avoid blocking the server
			this.sendResponse(client, request.id, null);
		}
	}

	private getSettingsSection(
		settings: Record<string, unknown>,
		section: string,
	): unknown {
		const parts = section.split(".");
		let current: unknown = settings;
		for (const part of parts) {
			if (current && typeof current === "object" && part in current) {
				current = (current as Record<string, unknown>)[part];
			} else {
				return undefined;
			}
		}
		return current;
	}

	/**
	 * Send a JSON-RPC request and wait for the response.
	 */
	async sendRequest(
		client: LspClient,
		method: string,
		params: unknown,
		signal?: AbortSignal,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<unknown> {
		if (signal?.aborted) {
			throw new Error("Request aborted");
		}

		const id = client.nextId++;
		client.lastUsed = Date.now();

		return new Promise((resolve, reject) => {
			const abortHandler = () => {
				client.pendingRequests.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", abortHandler);
				this.sendNotification(client, "$/cancelRequest", { id });
				reject(new Error("Request aborted"));
			};

			const timer = setTimeout(() => {
				client.pendingRequests.delete(id);
				signal?.removeEventListener("abort", abortHandler);
				this.sendNotification(client, "$/cancelRequest", { id });
				reject(
					new Error(
						`LSP request ${method} timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			signal?.addEventListener("abort", abortHandler, { once: true });

			client.pendingRequests.set(id, {
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

			const request: JsonRpcRequest = {
				jsonrpc: "2.0",
				id,
				method,
				params,
			};

			this.writeMessage(client, request);
		});
	}

	/**
	 * Send a notification (no response expected).
	 */
	sendNotification(
		client: LspClient,
		method: string,
		params: unknown,
	): void {
		const notification: JsonRpcNotification = {
			jsonrpc: "2.0",
			method,
			params,
		};
		this.writeMessage(client, notification);
	}

	private sendResponse(
		client: LspClient,
		id: number,
		result: unknown,
	): void {
		const response: JsonRpcResponse = {
			jsonrpc: "2.0",
			id,
			result,
		};
		this.writeMessage(client, response);
	}

	private writeMessage(
		client: LspClient,
		message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
	): void {
		const body = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
		const stdin = client.process.stdin;
		if (stdin && !stdin.destroyed) {
			stdin.write(header + body);
		}
	}

	/**
	 * Ensure a file is opened in the LSP server (sends didOpen or didChange).
	 */
	async syncFile(client: LspClient, filePath: string): Promise<void> {
		const absPath = resolve(this.cwd, filePath);
		const uri = fileToUri(absPath);
		const languageId = getLanguageId(absPath) ?? "plaintext";

		let content: string;
		try {
			content = readFileSync(absPath, "utf-8");
		} catch {
			return; // File doesn't exist
		}

		const existing = client.openFiles.get(uri);
		if (existing) {
			if (existing.content === content) return; // No changes

			existing.version++;
			existing.content = content;

			this.sendNotification(client, "textDocument/didChange", {
				textDocument: { uri, version: existing.version },
				contentChanges: [{ text: content }],
			});
		} else {
			client.openFiles.set(uri, { version: 1, content });

			this.sendNotification(client, "textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			});
		}
	}

	/**
	 * Get diagnostics for a file from a client's cache.
	 */
	getDiagnostics(client: LspClient, filePath?: string): Map<string, import("./types.js").Diagnostic[]> {
		if (filePath) {
			const uri = fileToUri(resolve(this.cwd, filePath));
			const diags = client.diagnostics.get(uri);
			if (diags) {
				return new Map([[uri, diags]]);
			}
			return new Map();
		}
		return client.diagnostics;
	}

	/**
	 * Get all active server names.
	 */
	getActiveServers(): string[] {
		return Array.from(this.clients.keys());
	}

	private startIdleChecker(): void {
		this.idleTimer = setInterval(() => {
			const now = Date.now();
			for (const [name, client] of this.clients) {
				if (now - client.lastUsed > IDLE_TIMEOUT_MS) {
					this.shutdownClient(name, client);
				}
			}
		}, IDLE_CHECK_INTERVAL_MS);
		// Don't prevent process exit
		this.idleTimer.unref();
	}

	private async shutdownClient(
		name: string,
		client: LspClient,
	): Promise<void> {
		try {
			// Send shutdown request
			await this.sendRequest(client, "shutdown", null, undefined, 5000);
			// Send exit notification
			this.sendNotification(client, "exit", null);
		} catch {
			// Force kill if shutdown fails
			client.process.kill("SIGTERM");
		}
		this.clients.delete(name);
	}

	/**
	 * Shut down all LSP servers.
	 */
	async shutdown(): Promise<void> {
		if (this.idleTimer) {
			clearInterval(this.idleTimer);
			this.idleTimer = null;
		}

		const shutdowns = Array.from(this.clients.entries()).map(
			([name, client]) => this.shutdownClient(name, client),
		);
		await Promise.allSettled(shutdowns);
	}
}
