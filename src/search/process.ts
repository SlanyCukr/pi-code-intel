import { spawn, type ChildProcess } from "node:child_process";
import { McpClient } from "./client.js";

/**
 * Manages the semvex MCP server subprocess lifecycle.
 */
export class SemvexProcess {
	private process: ChildProcess | null = null;
	private client: McpClient | null = null;
	private starting: Promise<McpClient> | null = null;
	private command: string;
	private args: string[];
	private cwd: string;

	constructor(
		cwd: string,
		command?: string,
		args?: string[],
	) {
		this.cwd = cwd;
		// Default: try semvex-mcp first, fall back to semvex
		this.command = command ?? "semvex-mcp";
		this.args = args ?? [];
	}

	/**
	 * Ensure semvex is running and return the MCP client.
	 * Idempotent — only starts once.
	 */
	async ensureRunning(): Promise<McpClient> {
		if (this.client) return this.client;
		if (this.starting) return this.starting;

		this.starting = this.start();

		try {
			this.client = await this.starting;
			return this.client;
		} catch (err) {
			this.starting = null;
			throw err;
		}
	}

	private async start(): Promise<McpClient> {
		const child = await this.spawnSemvex();

		this.process = child;

		// Collect stderr for error reporting
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			// Keep only last 2KB
			if (stderr.length > 2048) {
				stderr = stderr.slice(-2048);
			}
		});

		// Handle unexpected exit — always clear state
		child.on("exit", (code, signal) => {
			if (code !== 0 && code !== null) {
				console.error(`[semvex] Process exited with code ${code}${signal ? `, signal ${signal}` : ""}`);
			}
			this.client = null;
			this.process = null;
			this.starting = null;
		});

		child.on("error", (err) => {
			console.error("[semvex] Process error:", err.message);
			this.client = null;
			this.process = null;
			this.starting = null;
		});

		const client = new McpClient(child);

		try {
			await client.initialize(15_000);
		} catch (err) {
			child.kill("SIGTERM");
			this.process = null;

			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to initialize semvex: ${message}${stderr ? `\nstderr: ${stderr}` : ""}`,
			);
		}

		return client;
	}

	/**
	 * Try spawning semvex with fallback command variants.
	 */
	private async spawnSemvex(): Promise<ChildProcess> {
		const env = { ...process.env, WORKSPACE_ROOT: this.cwd };
		const opts = { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] as ("pipe")[], env };

		// If user specified custom args, use the command directly
		if (this.args.length > 0) {
			return spawn(this.command, this.args, opts);
		}

		// Try command variants in order
		const variants: Array<{ cmd: string; args: string[] }> = [
			{ cmd: this.command, args: ["--transport", "stdio"] },
			{ cmd: "semvex", args: ["--transport", "stdio"] },
			{ cmd: "uv", args: ["run", "semvex-mcp", "--transport", "stdio"] },
		];

		for (const variant of variants) {
			try {
				const child = spawn(variant.cmd, variant.args, opts);

				// Wait briefly to see if it fails immediately (bad command)
				const failed = await new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => resolve(false), 500);
					child.on("error", () => {
						clearTimeout(timer);
						resolve(true);
					});
					child.on("exit", (code: number | null) => {
						if (code !== null && code !== 0) {
							clearTimeout(timer);
							resolve(true);
						}
					});
				});

				if (!failed) return child;
			} catch (err) {
				console.error(`[semvex] Spawn attempt failed for variant:`, err instanceof Error ? err.message : err);
			}
		}

		// Last resort
		return spawn(this.command, ["--transport", "stdio"], opts);
	}

	/**
	 * Check if semvex is currently running.
	 */
	isRunning(): boolean {
		return this.process !== null && !this.process.killed;
	}

	/**
	 * Shut down the semvex process.
	 */
	async shutdown(): Promise<void> {
		this.starting = null;
		this.client = null;

		if (this.process) {
			const proc = this.process;
			this.process = null;

			proc.kill("SIGTERM");

			// Wait up to 3 seconds for graceful exit
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
					resolve();
				}, 3000);

				proc.on("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}
}
