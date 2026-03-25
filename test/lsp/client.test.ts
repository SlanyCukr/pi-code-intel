import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectSourceFiles } from "../../src/lsp/client.js";

const TS_EXTS = new Set([".ts"]);

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "lsp-client-test-"));
}

describe("collectSourceFiles", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("finds .ts files recursively", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "index.ts"), "");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "utils.ts"), "");
		mkdirSync(join(root, "src", "nested"));
		writeFileSync(join(root, "src", "nested", "deep.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(3);
		expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("utils.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("deep.ts"))).toBe(true);
	});

	it("does not include non-matching extensions", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "script.ts"), "");
		writeFileSync(join(root, "readme.md"), "");
		writeFileSync(join(root, "data.json"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith("script.ts")).toBe(true);
	});

	it("skips node_modules directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "app.ts"), "");
		mkdirSync(join(root, "node_modules", "lib"), { recursive: true });
		writeFileSync(join(root, "node_modules", "lib", "index.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith("app.ts")).toBe(true);
	});

	it("skips .git directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "main.ts"), "");
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
		writeFileSync(join(root, ".git", "config.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith("main.ts")).toBe(true);
	});

	it("skips dist directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "source.ts"), "");
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "source.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(1);
		expect(files[0].endsWith(join(root, "source.ts"))).toBe(true);
	});

	it("respects maxFiles limit", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		for (let i = 0; i < 10; i++) {
			writeFileSync(join(root, `file${i}.ts`), "");
		}

		const files = collectSourceFiles(root, TS_EXTS, 5);

		expect(files).toHaveLength(5);
	});

	it("returns all files when count is under maxFiles limit", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "a.ts"), "");
		writeFileSync(join(root, "b.ts"), "");

		const files = collectSourceFiles(root, TS_EXTS, 100);

		expect(files).toHaveLength(2);
	});

	it("handles symlink loop protection without infinite recursion", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		writeFileSync(join(root, "real.ts"), "");
		mkdirSync(join(root, "subdir"));

		// Create a symlink that points back to the root — would loop without protection
		try {
			symlinkSync(root, join(root, "subdir", "loop"));
		} catch {
			// Skip if symlink creation fails (e.g., no permissions)
			return;
		}

		// Should complete without hanging or throwing
		const files = collectSourceFiles(root, TS_EXTS);

		expect(files.some((f) => f.endsWith("real.ts"))).toBe(true);
	});

	it("returns empty array for empty directory", () => {
		const root = makeTempDir();
		tempDirs.push(root);

		const files = collectSourceFiles(root, TS_EXTS);

		expect(files).toHaveLength(0);
	});
});
