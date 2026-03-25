import { execFileSync } from "node:child_process";
import type { BashSpawnHook, BashSpawnContext } from "@mariozechner/pi-coding-agent";

/**
 * Verify RTK (Rust Token Killer) is installed.
 * Throws with install instructions if not found or if the wrong binary is on PATH.
 */
export function requireRtk(): void {
	try {
		const version = execFileSync("rtk", ["--version"], {
			encoding: "utf-8",
			timeout: 1000,
			stdio: "pipe",
		}).trim();
		// Guard against the rtk name collision (Rust Type Kit vs Rust Token Killer)
		if (!version.startsWith("rtk ")) {
			throw new Error(
				`Found an 'rtk' binary but it does not appear to be Rust Token Killer (got: "${version}").\n` +
					"You may have reachingforthejack/rtk (Rust Type Kit) installed instead.\n" +
					"See: https://github.com/rtk-ai/rtk",
			);
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes("does not appear to be")) {
			throw err; // Re-throw our own diagnostic error
		}
		throw new Error(
			"RTK (Rust Token Killer) is required but not installed.\n" +
				"Install: brew install rtk\n" +
				"Or: curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh\n" +
				"More info: https://github.com/rtk-ai/rtk",
		);
	}
}

/**
 * BashSpawnHook that routes commands through RTK for token-optimized output.
 *
 * Uses `rtk rewrite` — RTK's single source of truth for command rewriting.
 * Exit 0 + stdout = rewritten command. Exit 1 = no rewrite, use original.
 * Handles compound commands intelligently (e.g. `cd /tmp && git status`).
 */
export const rtkSpawnHook: BashSpawnHook = (
	ctx: BashSpawnContext,
): BashSpawnContext => {
	const trimmed = ctx.command.trimStart();
	// Don't double-wrap RTK commands
	if (trimmed.startsWith("rtk ") || trimmed === "rtk") {
		return ctx;
	}
	try {
		const rewritten = execFileSync("rtk", ["rewrite", ctx.command], {
			encoding: "utf-8",
			timeout: 1000,
			env: ctx.env,
			cwd: ctx.cwd,
			stdio: "pipe",
		}).trim();
		if (rewritten) {
			return { ...ctx, command: rewritten };
		}
	} catch (err: unknown) {
		// Exit code 1 is expected: RTK has no rewrite for this command.
		// Any other error is unexpected and should be logged.
		if (
			err instanceof Error &&
			"status" in err &&
			(err as { status: unknown }).status === 1
		) {
			// Expected: no rewrite available, use original command
		} else {
			console.error(
				"[code-intel] RTK rewrite failed unexpectedly:",
				err instanceof Error ? err.message : err,
			);
		}
	}
	return ctx;
};
