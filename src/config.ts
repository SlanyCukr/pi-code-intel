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
	/**
	 * Settings consumed by the session-analysis tooling.
	 *
	 * `captureSystemPrompt`: when true, the extension records the rendered
	 * system prompt to the session JSONL via `pi.appendEntry` on every
	 * `before_agent_start` event whose prompt has changed since the last
	 * capture. This grounds the analyzer's `propose` mode in what the
	 * agent actually saw at the time, instead of the present-day source.
	 * Disable to opt out of this on-disk capture.
	 */
	analysis: {
		captureSystemPrompt: boolean;
	};
}

const DEFAULT_CONFIG: CodeIntelConfig = {
	lsp: { enabled: true },
	agents: { enabled: true },
	prompt: { enabled: true },
	web: { enabled: true },
	context7: { enabled: true },
	analysis: { captureSystemPrompt: true },
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

const SIMPLE_ENABLED_SECTIONS = [
	"lsp",
	"agents",
	"prompt",
	"web",
	"context7",
] as const;

function mergeConfigFile(config: CodeIntelConfig, path: string): void {
	if (!existsSync(path)) return;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

		// Sections with a single `enabled: boolean` knob.
		for (const key of SIMPLE_ENABLED_SECTIONS) {
			const section = (raw as Record<string, unknown>)[key];
			if (section && typeof section === "object" && !Array.isArray(section)) {
				const enabled = (section as Record<string, unknown>).enabled;
				if (typeof enabled === "boolean") {
					config[key].enabled = enabled;
				}
			}
		}

		// Analysis section has its own field shape — picked individually
		// so unknown keys can't slip in.
		const analysis = (raw as Record<string, unknown>).analysis;
		if (analysis && typeof analysis === "object" && !Array.isArray(analysis)) {
			const capture = (analysis as Record<string, unknown>).captureSystemPrompt;
			if (typeof capture === "boolean") {
				config.analysis.captureSystemPrompt = capture;
			}
		}
	} catch (err) {
		// Intentional fallback: bad config file is non-fatal; defaults remain in effect
		console.error(`[code-intel] Failed to load config from ${path}:`, err instanceof Error ? err.message : err);
	}
}
