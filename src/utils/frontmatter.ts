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
 * Surrounding single or double quotes are stripped, matching YAML bare
 * string and quoted string conventions. Returns undefined when the key
 * is absent.
 */
export function getString(
	frontmatter: string,
	key: string,
): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	if (!match) return undefined;
	return match[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * Extracts a bracketed array value from a frontmatter block.
 *
 * Matches lines of the form `key: [a, b, c]` and returns the items as a
 * trimmed string array. Returns an empty array when the key is absent.
 */
export function getArray(frontmatter: string, key: string): string[] {
	const match = frontmatter.match(
		new RegExp(`^${key}:\\s*\\[([^\\]]+)\\]`, "m"),
	);
	if (!match) return [];
	return match[1].split(",").map((s) => s.trim());
}
