/**
 * Escape regex metacharacters so a string literal can be safely interpolated
 * into a `RegExp` source.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits a markdown file into its YAML-like frontmatter block and body.
 *
 * Expects the file to start with `---\n`, contain the frontmatter, then
 * `\n---\n` followed by the body. Returns null if the delimiter pattern
 * is not found.
 */
export function parseFrontmatter(
	content: string,
): { frontmatter: string; body: string } | null {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return null;
	return { frontmatter: match[1], body: match[2] };
}

/**
 * Extracts a scalar string value from a frontmatter block.
 *
 * Matches lines of the form `key: value` and returns the trimmed value.
 * Surrounding single or double quote pairs are stripped (only when both
 * leading and trailing quote characters match), matching YAML bare
 * string and quoted string conventions. Returns undefined when the key
 * is absent.
 */
export function getString(
	frontmatter: string,
	key: string,
): string | undefined {
	const match = frontmatter.match(
		new RegExp(`^${escapeRegex(key)}:\\s*(.+)$`, "m"),
	);
	if (!match) return undefined;
	const value = match[1].trim();
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Extracts a bracketed array value from a frontmatter block.
 *
 * Matches lines of the form `key: [a, b, c]` and returns the items as a
 * trimmed string array. Returns an empty array when the key is absent.
 */
export function getArray(frontmatter: string, key: string): string[] {
	const match = frontmatter.match(
		new RegExp(`^${escapeRegex(key)}:\\s*\\[([^\\]]+)\\]`, "m"),
	);
	if (!match) return [];
	return match[1].split(",").map((s) => s.trim());
}
