import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodeIntelConfig {
	lsp: {
		enabled: boolean;
	};
	search: {
		enabled: boolean;
		command: string;
	};
	agents: {
		enabled: boolean;
	};
	prompt: {
		enabled: boolean;
	};
}

const DEFAULT_CONFIG: CodeIntelConfig = {
	lsp: { enabled: true },
	search: { enabled: true, command: "semvex-mcp" },
	agents: { enabled: true },
	prompt: { enabled: true },
};

/**
 * Load config from .pi/code-intel.json (project) and ~/.pi/agent/code-intel.json (user).
 * Project overrides user overrides defaults.
 */
export function loadCodeIntelConfig(cwd: string): CodeIntelConfig {
	const config = structuredClone(DEFAULT_CONFIG);

	// User-level config
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	mergeConfigFile(config, join(home, ".pi", "agent", "code-intel.json"));

	// Project-level config
	mergeConfigFile(config, join(cwd, ".pi", "code-intel.json"));

	return config;
}

function mergeConfigFile(config: CodeIntelConfig, path: string): void {
	if (!existsSync(path)) return;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (raw && typeof raw === "object") {
			if (raw.lsp && typeof raw.lsp === "object") {
				Object.assign(config.lsp, raw.lsp);
			}
			if (raw.search && typeof raw.search === "object") {
				Object.assign(config.search, raw.search);
			}
			if (raw.agents && typeof raw.agents === "object") {
				Object.assign(config.agents, raw.agents);
			}
			if (raw.prompt && typeof raw.prompt === "object") {
				Object.assign(config.prompt, raw.prompt);
			}
		}
	} catch {
		// Invalid config — silently ignore
	}
}
