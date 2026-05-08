import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import type { AnyModel } from "./types.js";

/**
 * Options for `createIsolatedSession`. A subset of `createAgentSession`
 * options — only the parameters meaningful for a one-off, no-tools,
 * no-extensions LLM call.
 */
export interface IsolatedSessionOptions {
	cwd: string;
	model?: AnyModel;
}

/**
 * Spawn a single-turn LLM session that is fully isolated from the
 * surrounding pi extension environment.
 *
 * Why this exists: `createAgentSession` defaults to constructing a
 * `DefaultResourceLoader` that walks up from `cwd` and re-loads the
 * project's pi extensions. When called from inside our own running
 * extension (summarizer, propose mode, etc.), that re-load means OUR
 * `before_agent_start` prompt rewriter and capture hook attach to the
 * inner session. The caller's `setSystemPrompt("")` then gets silently
 * overwritten on the next agent loop, and the inner session runs under
 * the full code-intel system prompt and tool set instead of being the
 * no-tools / no-prompt single-turn call it was meant to be.
 *
 * The fix is to pass a resource loader configured to skip extensions,
 * skills, prompt templates, and themes. The session that comes back
 * has no chained extension behavior — only the model and any tools the
 * caller explicitly passes.
 *
 * Returns the same shape as `createAgentSession`. Caller is responsible
 * for `dispose()`-ing the session. In-memory session storage by default
 * so isolated calls never write JSONL to disk.
 */
export async function createIsolatedSession(
	options: IsolatedSessionOptions,
): Promise<Awaited<ReturnType<typeof createAgentSession>>> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	return createAgentSession({
		cwd: options.cwd,
		model: options.model,
		tools: [],
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(options.cwd),
	});
}
