import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { SemvexProcess } from "./process.js";

const searchCodeSchema = Type.Object(
	{
		query: Type.String({
			description:
				"Semantic search query describing the concept, functionality, or code pattern you're looking for. Use natural language — the search understands meaning, not just keywords.",
		}),
		language: Type.Optional(
			Type.String({
				description:
					"Filter results to a specific language (e.g. 'python', 'typescript'). Omit to search all languages.",
			}),
		),
	},
	{ additionalProperties: false },
);

const searchDocsSchema = Type.Object(
	{
		query: Type.String({
			description:
				"Search query for project documentation (README, guides, API docs). Use natural language.",
		}),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum number of results to return. Default: 5.",
			}),
		),
	},
	{ additionalProperties: false },
);

type SearchCodeInput = Static<typeof searchCodeSchema>;
type SearchDocsInput = Static<typeof searchDocsSchema>;

async function callSemvexTool(
	semvex: SemvexProcess,
	toolName: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<string> {
	const client = await semvex.ensureRunning();
	const result = await client.callTool(toolName, args, signal);

	if (result.isError) {
		throw new Error(result.content[0]?.text ?? "Unknown search error");
	}

	return result.content.map((c) => c.text).join("\n");
}

export function createSearchTools(
	semvex: SemvexProcess,
): [
	ToolDefinition<typeof searchCodeSchema>,
	ToolDefinition<typeof searchDocsSchema>,
] {
	const searchCodeTool: ToolDefinition<typeof searchCodeSchema> = {
		name: "search_code",
		label: "Semantic Code Search",
		description: `Search the codebase by meaning using semantic search. Finds code related to concepts, not just text patterns.

Use this when you want to:
- Find code that handles a concept (e.g. "authentication middleware", "database connection pooling")
- Discover how a feature is implemented across the codebase
- Find similar patterns or implementations

For exact text/string search, use grep instead.
First call may take a few seconds to start the search engine.`,
		parameters: searchCodeSchema,
		async execute(_toolCallId, input, signal) {
			const args: Record<string, unknown> = { query: input.query };
			if (input.language) args.language = input.language;

			const text = await callSemvexTool(
				semvex,
				"search_code_tool",
				args,
				signal,
			);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};

	const searchDocsTool: ToolDefinition<typeof searchDocsSchema> = {
		name: "search_docs",
		label: "Documentation Search",
		description: `Search project documentation (README, guides, API docs) using semantic search.

Use this when you want to:
- Find project setup instructions
- Understand architecture decisions
- Find API usage examples
- Locate contributing guidelines`,
		parameters: searchDocsSchema,
		async execute(_toolCallId, input, signal) {
			const args: Record<string, unknown> = { query: input.query };
			if (input.limit) args.limit = input.limit;

			const text = await callSemvexTool(
				semvex,
				"search_docs_tool",
				args,
				signal,
			);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};

	return [searchCodeTool, searchDocsTool];
}
