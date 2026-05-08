import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CodeIntelConfig {
	lsp: {
		enabled: boolean;
	};
	agents: {
		enabled: boolean;
	};
	prompt: {
		enabled: boolean;
	};
	web: {
		enabled: boolean;
	};
	context7: {
		enabled: boolean;
	};
}

const DEFAULT_CONFIG: CodeIntelConfig = {
	lsp: { enabled: true },
	agents: { enabled: true },
	prompt: { enabled: true },
	web: { enabled: true },
	context7: { enabled: true },
};

/**
 * Load config from .pi/code-intel.json (project) and ~/.pi/agent/code-intel.json (user).
 * Project overrides user overrides defaults.
 */
export function loadCodeIntelConfig(cwd: string): CodeIntelConfig {
	const config = structuredClone(DEFAULT_CONFIG);

	// User-level config
	const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	mergeConfigFile(config, join(home, ".pi", "agent", "code-intel.json"));

	// Project-level config
	mergeConfigFile(config, join(cwd, ".pi", "code-intel.json"));

	return config;
}

const CONFIG_SECTIONS = ["lsp", "agents", "prompt", "web", "context7"] as const;

function mergeConfigFile(config: CodeIntelConfig, path: string): void {
	if (!existsSync(path)) return;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const key of CONFIG_SECTIONS) {
				const section = raw[key];
				if (section && typeof section === "object" && !Array.isArray(section)) {
					// Pick only known keys to prevent injection of unknown properties
					if (typeof section.enabled === "boolean") {
						config[key].enabled = section.enabled;
					}
				}
			}
		}
	} catch (err) {
		// Intentional fallback: bad config file is non-fatal; defaults remain in effect
		console.error(`[code-intel] Failed to load config from ${path}:`, err instanceof Error ? err.message : err);
	}
}
