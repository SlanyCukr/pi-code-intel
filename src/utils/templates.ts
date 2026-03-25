import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Load all markdown files from a directory, parse each one, and return the
 * successfully parsed results.
 *
 * Handles the .md filter, readFileSync, try/catch with console.error, and
 * the skip-on-null contract. Callers supply only the parse function.
 *
 * @param dir       - Absolute path to the directory to scan.
 * @param parse     - Function that turns file content + filename into T, or
 *                    null if the file should be skipped.
 */
export function loadMarkdownDir<T>(
	dir: string,
	parse: (content: string, filename: string) => T | null,
): T[] {
	const results: T[] = [];

	let files: string[];
	try {
		files = readdirSync(dir);
	} catch (err) {
		console.error(
			`[code-intel] Failed to read directory ${dir}:`,
			err instanceof Error ? err.message : err,
		);
		return results;
	}

	for (const file of files) {
		if (!file.endsWith(".md")) continue;

		let content: string;
		try {
			content = readFileSync(join(dir, file), "utf-8");
		} catch (err) {
			console.error(
				`[code-intel] Failed to read ${file}:`,
				err instanceof Error ? err.message : err,
			);
			continue;
		}

		const parsed = parse(content, file);
		if (parsed !== null) {
			results.push(parsed);
		}
	}

	return results;
}
