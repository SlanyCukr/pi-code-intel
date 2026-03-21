import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

// Copy LSP defaults.json
mkdirSync(join(dist, "lsp"), { recursive: true });
cpSync(join(root, "src", "lsp", "defaults.json"), join(dist, "lsp", "defaults.json"));

// Copy agent templates
cpSync(join(root, "src", "agents", "templates"), join(dist, "agents", "templates"), { recursive: true });

console.log("Assets copied to dist/");
