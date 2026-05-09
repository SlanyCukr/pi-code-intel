import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Runtime methods the pi SDK exposes (per peerDep `^0.62`) but that
 * aren't yet declared on the public `ExtensionAPI` type surface.
 *
 * Centralizing these casts here avoids per-file `pi as any` escapes —
 * `capture.ts` and `commands/registry.ts` previously each declared
 * their own ad-hoc shape. Methods are kept optional in the type so the
 * extension can guard against forks/older installs that don't ship
 * them; the guard logs a clear "SDK does not support X" and degrades
 * gracefully rather than throwing.
 *
 * If a method here gets promoted to the SDK's public types, drop it
 * from this interface — the typed surface is the source of truth.
 */
export interface ExtendedSdkApi {
	appendEntry?(customType: string, data: unknown): void;
	registerCommand?(name: string, def: SdkCommandDef): void;
	sendUserMessage?(text: string): void;
}

export interface SdkCommandDef {
	description: string;
	handler: (
		args: string,
		ctx: { ui: { notify: (msg: string, level: string) => void } },
	) => unknown;
}

/**
 * Cast a runtime `ExtensionAPI` to its extended typed view.
 *
 * The cast is type-only; behavior is unchanged. Consumers should still
 * runtime-check optional methods before calling them.
 */
export function asExtendedApi(pi: ExtensionAPI): ExtensionAPI & ExtendedSdkApi {
	return pi as ExtensionAPI & ExtendedSdkApi;
}

/**
 * Defensive read of `getActiveTools`.
 *
 * `ExtensionAPI` declares this method as required, but a fork or a
 * stripped-down host might omit it; the previous capture flow was
 * tested against that case. We narrow through an optional view so the
 * caller stays simple.
 */
export function safeGetActiveTools(pi: ExtensionAPI): string[] {
	const fn = (pi as { getActiveTools?: () => string[] }).getActiveTools;
	return typeof fn === "function" ? fn.call(pi) : [];
}
