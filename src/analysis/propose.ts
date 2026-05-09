import { existsSync, readFileSync } from "node:fs";
import { runIsolatedTextCall } from "../utils/isolated-text-call.js";
import type { AnyModel } from "../types.js";
import { formatPercent, formatRatio } from "./format.js";
import type { AggregatedMetrics, SessionMetrics } from "./metrics.js";
import type { AntiPatternHit, ParsedSession } from "./types.js";

/**
 * Source of the system prompt fed to the proposer LLM.
 *
 * - `captured`: at least one of the analyzed sessions contains a
 *   `system_prompt_captured` event. We use the most-recent capture
 *   as the basis. Proposals are grounded in what the agent saw.
 * - `source-fallback`: no analyzed session has a capture. We read the
 *   current `src/prompt/system-prompt.ts` SOURCE so the LLM at least
 *   has something to amend, but the resulting proposals are clearly
 *   forward-looking (the prompt at session time is unknown).
 * - `none`: neither path produced anything. We surface the fact and
 *   skip the LLM call.
 */
export type ProposalGrounding =
	| { kind: "captured"; sessionId: string; capturedAt: string; text: string }
	| { kind: "source-fallback"; sourcePath: string; text: string }
	| { kind: "none"; reason: string };

export interface ProposeInput {
	aggregated: AggregatedMetrics;
	sessionMetrics: SessionMetrics[];
	hitsBySession: Map<string, AntiPatternHit[]>;
	parsedSessions: ParsedSession[];
	/** Path to fall back to when no session contains a captured prompt. */
	systemPromptSourcePath: string;
}

export interface ProposeOptions {
	/** Optional pi-ai model. If omitted, createAgentSession uses settings/defaults. */
	model?: AnyModel;
	/** Working directory for the (in-memory) session storage. */
	cwd: string;
	/** Abort signal for cancellation propagation. */
	signal?: AbortSignal;
}

/**
 * Pick the prompt that will ground the proposal LLM call.
 *
 * Strategy:
 *  1. Walk every analyzed session in reverse chronological order
 *     (newest first). The first `system_prompt_captured` event we
 *     find wins — most-recent observation is the most representative
 *     of the agent's current behavior.
 *  2. If no captures exist anywhere, fall back to reading the file at
 *     `systemPromptSourcePath`. This is the source-of-truth at
 *     analysis time; proposals against it are forward-looking.
 *  3. If neither path produces text, return `kind: "none"`.
 */
export function selectGrounding(
	parsedSessions: ParsedSession[],
	systemPromptSourcePath: string,
): ProposalGrounding {
	const sortedSessions = [...parsedSessions].sort((a, b) =>
		b.header.timestamp.localeCompare(a.header.timestamp),
	);
	for (const session of sortedSessions) {
		// Walk events in reverse so we get the most recent capture in
		// each session.
		for (let i = session.events.length - 1; i >= 0; i--) {
			const ev = session.events[i];
			if (ev.kind === "system_prompt_captured") {
				return {
					kind: "captured",
					sessionId: session.header.id,
					capturedAt: ev.capturedAt,
					text: ev.text,
				};
			}
		}
	}

	// Fallback: try to read the prompt source file.
	if (!existsSync(systemPromptSourcePath)) {
		return {
			kind: "none",
			reason: `no captured system prompts in analyzed sessions and source path \`${systemPromptSourcePath}\` not found`,
		};
	}
	try {
		const text = readFileSync(systemPromptSourcePath, "utf-8");
		if (!text.trim()) {
			return {
				kind: "none",
				reason: `no captured system prompts and source file \`${systemPromptSourcePath}\` is empty`,
			};
		}
		return { kind: "source-fallback", sourcePath: systemPromptSourcePath, text };
	} catch (err) {
		return {
			kind: "none",
			reason: `no captured prompts; failed to read \`${systemPromptSourcePath}\`: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
}

export interface BuildProposalPromptInput {
	aggregated: AggregatedMetrics;
	hits: AntiPatternHit[];
	grounding: ProposalGrounding;
	/** Max number of anti-pattern hits to include; defaults to 20. */
	topK?: number;
}

/**
 * Build the prompt for the proposer LLM. Pure function, deterministic
 * given its inputs — easy to snapshot-test.
 *
 * Layout:
 *   <intro & role>
 *   <metrics dump>
 *   <top-K anti-pattern hits>
 *   <grounding header + system prompt verbatim>
 *   <task spec>
 *
 * `topK` caps the number of hits included to keep the prompt under a
 * reasonable token budget; rule frequencies still appear via the
 * metrics block, and per-hit detail is bounded.
 */
export function buildProposalPrompt(input: BuildProposalPromptInput): string {
	const topK = input.topK ?? 20;
	const lines: string[] = [];

	lines.push(
		"You are reviewing analytics from a coding agent's tool-use logs to recommend specific amendments to its system prompt.",
		"Your goal: identify systematic deficiencies and propose surgical changes that would prevent the most-flagged anti-patterns from recurring.",
		"You are NOT writing new prompts from scratch. You are amending an existing one.",
		"",
		"## Aggregated metrics",
		"",
	);
	const a = input.aggregated;
	lines.push(`- Sessions analyzed: ${a.sessionCount}`);
	lines.push(`- Total tool calls: ${a.totalToolCalls}`);
	lines.push(`- Total tool errors: ${a.totalToolErrors}`);
	lines.push(
		`- read calls: ${a.totalReads} | lsp calls: ${a.totalLspCalls} | bash calls: ${a.totalBashCalls} | bash classified as grep-like: ${a.totalGrepCalls} | edit calls: ${a.totalEdits}`,
	);
	lines.push(
		`- Ratios: read:lsp=${formatRatio(a.readLspRatio)}, grep:lsp=${formatRatio(a.grepLspRatio)}, edit-failure-rate=${formatPercent(a.editFailureRate)}`,
	);
	lines.push("");
	lines.push("## Top anti-pattern hits");
	lines.push("");

	// Group by ruleId, then take up to topK total.
	const byRule = new Map<string, AntiPatternHit[]>();
	for (const h of input.hits) {
		const arr = byRule.get(h.ruleId);
		if (arr) arr.push(h);
		else byRule.set(h.ruleId, [h]);
	}
	const ruleIds = [...byRule.keys()].sort(
		(a, b) => byRule.get(b)!.length - byRule.get(a)!.length,
	);
	let included = 0;
	for (const id of ruleIds) {
		const hits = byRule.get(id)!;
		lines.push(`### \`${id}\` — ${hits.length} hit${hits.length === 1 ? "" : "s"}`);
		const sample = hits.slice(0, Math.max(1, Math.floor(topK / ruleIds.length)));
		for (const h of sample) {
			lines.push(`- ${h.message}`);
			included++;
			if (included >= topK) break;
		}
		if (included >= topK) break;
		lines.push("");
	}
	if (included === 0) {
		lines.push("(no anti-pattern hits across analyzed sessions)");
		lines.push("");
	}
	lines.push("");

	// Grounding section
	lines.push("## System prompt being amended");
	lines.push("");
	if (input.grounding.kind === "captured") {
		lines.push(
			`This is the system prompt the agent actually saw, captured during session \`${input.grounding.sessionId.slice(0, 8)}\` at \`${input.grounding.capturedAt}\`.`,
		);
	} else if (input.grounding.kind === "source-fallback") {
		lines.push(
			`No captured prompt was available in the analyzed sessions. Below is the current SOURCE of the system prompt (\`${input.grounding.sourcePath}\`).`,
			"NOTE: this may not be exactly what the agent saw at session time, since the source can have changed. Treat your proposals as forward-looking.",
		);
	} else {
		lines.push(`(grounding unavailable: ${input.grounding.reason})`);
	}
	lines.push("");
	if (input.grounding.kind !== "none") {
		lines.push("```");
		lines.push(input.grounding.text);
		lines.push("```");
		lines.push("");
	}

	lines.push(
		"## Your task",
		"",
		"For each anti-pattern with a notable hit count, propose:",
		"",
		"1. **Diagnosis** — which existing rule is failing or absent.",
		"2. **Amendment** — concrete text to add or strengthen. Quote the existing text being changed when possible. Be specific; vague advice (\"emphasize LSP more\") is not useful.",
		"3. **Rationale** — tie the change directly to the metric or hits above.",
		"",
		"Output strict markdown only. No conversational preamble. Start with `## Proposed amendments` as the top-level heading.",
		"If the data does not justify any amendments, output `## Proposed amendments` followed by a single bullet noting that.",
	);

	return lines.join("\n");
}

/**
 * Run the proposer: call the LLM with the built prompt, return the
 * generated markdown verbatim. The caller embeds it into section 5 of
 * the report.
 *
 * Delegates lifecycle + abort wiring to `runIsolatedTextCall`. On any
 * failure (model unavailable, API error, abort) returns a markdown
 * error block rather than throwing — propose mode failure must not
 * abort the rest of the report.
 */
export async function generateProposals(
	input: ProposeInput,
	options: ProposeOptions,
): Promise<string> {
	const grounding = selectGrounding(input.parsedSessions, input.systemPromptSourcePath);
	if (grounding.kind === "none") {
		return [
			"## Proposed amendments",
			"",
			`*(skipped: ${grounding.reason})*`,
		].join("\n");
	}

	const flatHits: AntiPatternHit[] = [];
	for (const arr of input.hitsBySession.values()) flatHits.push(...arr);

	const userPrompt = buildProposalPrompt({
		aggregated: input.aggregated,
		hits: flatHits,
		grounding,
	});

	let result;
	try {
		result = await runIsolatedTextCall(userPrompt, {
			cwd: options.cwd,
			model: options.model,
			signal: options.signal,
		});
	} catch (err) {
		return errorBlock(
			`LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (result.kind === "aborted") {
		return errorBlock(
			result.phase === "before"
				? "aborted before LLM call"
				: "aborted during session setup",
		);
	}
	if (result.kind === "no-text") return errorBlock("model produced no text output");

	const footer = renderGroundingFooter(grounding);
	return result.text.endsWith("\n")
		? result.text + footer
		: result.text + "\n\n" + footer;
}

function renderGroundingFooter(grounding: ProposalGrounding): string {
	if (grounding.kind === "captured") {
		return `*Grounded in the system prompt captured during session \`${grounding.sessionId.slice(0, 8)}\` at ${grounding.capturedAt}.*`;
	}
	if (grounding.kind === "source-fallback") {
		return `*Grounded in the current source at \`${grounding.sourcePath}\` (no captures in analyzed sessions; proposals are forward-looking).*`;
	}
	return `*Grounding: ${grounding.reason}.*`;
}

function errorBlock(reason: string): string {
	return [
		"## Proposed amendments",
		"",
		`*(propose mode failed: ${reason})*`,
	].join("\n");
}

