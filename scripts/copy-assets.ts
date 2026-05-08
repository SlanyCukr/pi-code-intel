import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

// Copy LSP defaults.json
mkdirSync(join(dist, "lsp"), { recursive: true });
cpSync(join(root, "src", "lsp", "defaults.json"), join(dist, "lsp", "defaults.json"));

// Copy agent templates (clean first to remove stale entries)
rmSync(join(dist, "agents", "templates"), { recursive: true, force: true });
cpSync(join(root, "src", "agents", "templates"), join(dist, "agents", "templates"), { recursive: true });

// Copy command templates (clean first to remove stale entries)
rmSync(join(dist, "commands", "templates"), { recursive: true, force: true });
cpSync(join(root, "src", "commands", "templates"), join(dist, "commands", "templates"), { recursive: true });

// Copy standalone scripts that slash commands invoke from
// `$EXTENSION_DIST/...` paths. Without this, the read-session command
// (and any future similar wrappers) would fail when pi is loaded into
// any project other than this one — a relative `scripts/...` path
// resolves into the user's cwd, not into the extension's install path.
mkdirSync(join(dist, "scripts"), { recursive: true });
cpSync(join(root, "scripts", "parse-session.py"), join(dist, "scripts", "parse-session.py"));

console.log("Assets copied to dist/");
