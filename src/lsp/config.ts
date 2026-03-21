import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LspConfiguration {
	servers: Record<string, ServerConfig>;
}

/**
 * Load and merge LSP configurations from:
 * 1. Built-in defaults.json
 * 2. User config: ~/.pi/agent/lsp.json
 * 3. Project config: .pi/lsp.json
 * Project overrides user overrides defaults.
 */
export function loadLspConfig(cwd: string): LspConfiguration {
	// 1. Load built-in defaults
	const defaultsPath = join(__dirname, "defaults.json");
	let servers: Record<string, ServerConfig> = {};
	try {
		const raw = readFileSync(defaultsPath, "utf-8");
		servers = JSON.parse(raw);
	} catch {
		// Defaults missing — continue with empty
	}

	// 2. User-level overrides
	const userConfigPath = join(
		process.env.HOME ?? process.env.USERPROFILE ?? "~",
		".pi",
		"agent",
		"lsp.json",
	);
	mergeConfigFile(servers, userConfigPath);

	// 3. Project-level overrides
	const projectConfigPath = join(cwd, ".pi", "lsp.json");
	mergeConfigFile(servers, projectConfigPath);

	return { servers };
}

function mergeConfigFile(
	servers: Record<string, ServerConfig>,
	configPath: string,
): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw);
		if (config && typeof config === "object") {
			for (const [name, server] of Object.entries(config)) {
				if (server && typeof server === "object") {
					servers[name] = { ...servers[name], ...(server as ServerConfig) };
				}
			}
		}
	} catch {
		// Invalid config — silently ignore
	}
}

/**
 * Find servers that handle a given file extension.
 * Non-linters are returned first.
 */
export function getServersForFile(
	config: LspConfiguration,
	filePath: string,
): { name: string; config: ServerConfig }[] {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	const matches: { name: string; config: ServerConfig; isLinter: boolean }[] =
		[];

	for (const [name, server] of Object.entries(config.servers)) {
		if (server.fileTypes.includes(ext)) {
			matches.push({ name, config: server, isLinter: !!server.isLinter });
		}
	}

	// Non-linters first
	matches.sort((a, b) => {
		if (a.isLinter !== b.isLinter) return a.isLinter ? 1 : -1;
		return 0;
	});

	return matches.map((m) => ({ name: m.name, config: m.config }));
}

/**
 * Resolve a server command, checking project-local paths first.
 */
export function resolveCommand(
	serverConfig: ServerConfig,
	cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
	const cmd = serverConfig.command;
	const args = serverConfig.args ?? [];
	const env = serverConfig.env;

	// Check project-local paths
	const localPaths = [
		join(cwd, "node_modules", ".bin", cmd),
		join(cwd, ".venv", "bin", cmd),
		join(cwd, "venv", "bin", cmd),
	];

	for (const localPath of localPaths) {
		if (existsSync(localPath)) {
			return { command: localPath, args, env };
		}
	}

	// Fall back to system PATH
	return { command: cmd, args, env };
}

/**
 * Check if a project has root markers for any language server.
 */
export function detectProjectServers(
	config: LspConfiguration,
	cwd: string,
): string[] {
	const detected: string[] = [];

	for (const [name, server] of Object.entries(config.servers)) {
		if (server.rootMarkers.length === 0) continue;
		for (const marker of server.rootMarkers) {
			if (marker.includes("*")) {
				// Glob pattern — simple check for common patterns like *.sln
				continue;
			}
			if (existsSync(join(cwd, marker))) {
				detected.push(name);
				break;
			}
		}
	}

	return detected;
}
