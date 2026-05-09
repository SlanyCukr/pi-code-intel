import { Type, type Static } from "@sinclair/typebox";
import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
	AgentToolUpdateCallback,
} from "@mariozechner/pi-coding-agent";
import { fetchUrl } from "./fetch.js";
import { summarizeContent } from "./summarizer.js";

const fetchSchema = Type.Object(
	{
		url: Type.String({
			description: "The URL to fetch. Must be a valid HTTP/HTTPS URL.",
		}),
		prompt: Type.String({
			description:
				"What information to extract from the page. Be specific about what you need — e.g., 'How do I configure route middleware?' rather than 'summarize this page'.",
		}),
	},
	{ additionalProperties: false },
);

type FetchInput = Static<typeof fetchSchema>;

export const FETCH_TOOL_NAME = "fetch";

/**
 * Create the web fetch tool.
 *
 * Fetches a URL, converts HTML to markdown, and optionally summarizes
 * large content using a lightweight model call.
 */
export function createFetchTool(cwd: string): ToolDefinition<typeof fetchSchema> {
	return {
		name: FETCH_TOOL_NAME,
		label: "Fetch",
		description:
			"Fetch a URL and extract content. Converts HTML to markdown, summarizes large pages using a model call. Use for documentation, API references, and web resources.",
		parameters: fetchSchema,
		async execute(
			_toolCallId: string,
			input: FetchInput,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			onUpdate?.({
				content: [{ type: "text" as const, text: `Fetching ${input.url}...` }],
				details: undefined,
			});

			// Fetch and convert
			const result = await fetchUrl(input.url, signal);

			onUpdate?.({
				content: [
					{
						type: "text" as const,
						text: `Fetched ${input.url} (${result.contentType}, ${result.content.length} chars${result.truncated ? ", truncated" : ""})`,
					},
				],
				details: undefined,
			});

			// Summarize if content is large
			const output = await summarizeContent({
				content: result.content,
				prompt: input.prompt,
				cwd,
				model: ctx.model,
				signal,
			});

			return {
				content: [{ type: "text" as const, text: output }],
				details: undefined,
			};
		},
	};
}
