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
 * Handles compound commands intelligently (e.g. `cd /tmp && git status`).
 *
 * Exit-code semantics across rtk versions:
 *   - 0 with stdout: rewritten command (older rtk versions, e.g. 0.31)
 *   - 1: no rewrite available; use the original command
 *   - 3 with stdout: rewritten command + stderr deprecation warning
 *     (rtk 0.39+ emits this when its global hook config is outdated;
 *     the warning is unrelated to programmatic `rewrite` usage but
 *     shares the exit code)
 *
 * Anything else with empty stdout is treated as an unexpected failure
 * and logged. The contract for callers is the same: trust the returned
 * command.
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
		if (err instanceof Error && "status" in err) {
			const status = (err as { status: unknown }).status;

			// Exit 1: no rewrite available. Expected, fall through.
			if (status === 1) {
				return ctx;
			}

			// Exit 3 (or any other non-zero) with stdout content: trust
			// stdout. rtk 0.39+ emits a deprecation warning on stderr
			// alongside a perfectly good rewrite on stdout.
			const stdoutRaw = (err as { stdout?: Buffer | string }).stdout;
			const stdoutText =
				typeof stdoutRaw === "string"
					? stdoutRaw
					: stdoutRaw
						? stdoutRaw.toString("utf-8")
						: "";
			const rewritten = stdoutText.trim();
			if (rewritten) {
				return { ...ctx, command: rewritten };
			}

			// Non-zero exit with no stdout: unexpected. Log and fall through.
			console.error(
				`[code-intel] RTK rewrite exited ${status} with no output:`,
				err.message,
			);
		} else {
			console.error(
				"[code-intel] RTK rewrite failed unexpectedly:",
				err instanceof Error ? err.message : err,
			);
		}
	}
	return ctx;
};
