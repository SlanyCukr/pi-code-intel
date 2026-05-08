import type {
	AggregatedMetrics,
	SessionMetrics,
} from "./metrics.js";
import type { AntiPatternHit } from "./types.js";

/**
 * Inputs to the markdown renderer. Sections that aren't ready for this
 * phase (outcomes, proposals) are passed as `undefined` and rendered as
 * "(not requested)" or "(no findings)" depending on the section.
 */
export interface RenderInput {
	generatedAt: Date;
	sessionMetrics: SessionMetrics[];
	aggregated: AggregatedMetrics;
	/** Map session id → hits found in that session. */
	hitsBySession: Map<string, AntiPatternHit[]>;
	/** Section 4 — phase 5 will populate this. */
	outcomes?: never;
	/** Section 5 — phase 6 will populate this. */
	proposals?: never;
}

/**
 * Render the full markdown analysis report.
 *
 * Layout: five sections, each with a stable heading. Empty sections
 * render `(no findings)` rather than disappear, so the operator can
 * tell the difference between "we checked and saw nothing" and "we
 * skipped this section".
 */
export function renderMarkdown(input: RenderInput): string {
	const out: string[] = [];
	out.push(`# Pi session analysis — ${formatDate(input.generatedAt)}`);
	out.push("");
	out.push(`Generated: ${input.generatedAt.toISOString()}`);
	out.push("");
	out.push(renderSummary(input));
	out.push(renderEfficiency(input));
	out.push(renderAntiPatterns(input));
	out.push(renderOutcomes(input));
	out.push(renderProposals(input));
	return out.join("\n");
}

function renderSummary(input: RenderInput): string {
	const { sessionMetrics, aggregated } = input;
	const lines: string[] = [];
	lines.push("## 1. Summary");
	lines.push("");
	if (sessionMetrics.length === 0) {
		lines.push("(no sessions analyzed)");
		lines.push("");
		return lines.join("\n");
	}

	const totalDurMin = sessionMetrics
		.map((m) => m.durationMs ?? 0)
		.reduce((a, b) => a + b, 0) / 60_000;
	const malformedTotal = sessionMetrics
		.map((m) => m.malformedLines)
		.reduce((a, b) => a + b, 0);

	lines.push(`- Sessions analyzed: **${sessionMetrics.length}**`);
	lines.push(`- Total tool calls: **${aggregated.totalToolCalls}**`);
	lines.push(`- Total tool errors: **${aggregated.totalToolErrors}**`);
	lines.push(`- Combined wall-clock duration: **${totalDurMin.toFixed(1)} min**`);
	if (malformedTotal > 0) {
		lines.push(`- Malformed JSONL lines skipped: **${malformedTotal}**`);
	}
	lines.push("");
	lines.push("### Top tools by call frequency");
	lines.push("");
	lines.push("| Tool | Calls |");
	lines.push("|---|---:|");
	for (const t of aggregated.topToolsByFrequency.slice(0, 10)) {
		lines.push(`| \`${t.name}\` | ${t.count} |`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderEfficiency(input: RenderInput): string {
	const { aggregated } = input;
	const lines: string[] = [];
	lines.push("## 2. Efficiency");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|---|---:|");
	lines.push(`| read calls | ${aggregated.totalReads} |`);
	lines.push(`| lsp calls | ${aggregated.totalLspCalls} |`);
	lines.push(`| bash calls | ${aggregated.totalBashCalls} |`);
	lines.push(`| bash classified as grep-like | ${aggregated.totalGrepCalls} |`);
	lines.push(`| edit calls | ${aggregated.totalEdits} |`);
	lines.push(`| **read : lsp** | ${formatRatio(aggregated.readLspRatio)} |`);
	lines.push(`| **grep : lsp** | ${formatRatio(aggregated.grepLspRatio)} |`);
	lines.push(`| **edit failure rate** | ${formatPercent(aggregated.editFailureRate)} |`);
	lines.push(`| avg reads / session | ${aggregated.avgReadsPerSession.toFixed(1)} |`);
	lines.push(`| avg tool calls / session | ${aggregated.avgToolCallsPerSession.toFixed(1)} |`);
	lines.push("");
	if (aggregated.readLspRatio !== null && aggregated.readLspRatio > 1.5) {
		lines.push(
			`> read:lsp = ${aggregated.readLspRatio.toFixed(2)} suggests over-reading. Consider tightening the system-prompt rule that ` +
				`directs the agent to prefer LSP for symbol/structure queries.`,
		);
		lines.push("");
	}
	return lines.join("\n");
}

function renderAntiPatterns(input: RenderInput): string {
	const { hitsBySession, sessionMetrics } = input;
	const lines: string[] = [];
	lines.push("## 3. Anti-patterns");
	lines.push("");

	// Aggregate hits per rule across all sessions.
	const byRule = new Map<string, AntiPatternHit[]>();
	for (const hits of hitsBySession.values()) {
		for (const h of hits) {
			const arr = byRule.get(h.ruleId);
			if (arr) arr.push(h);
			else byRule.set(h.ruleId, [h]);
		}
	}

	if (byRule.size === 0) {
		lines.push("(no findings)");
		lines.push("");
		return lines.join("\n");
	}

	const sessionLookup = new Map<string, SessionMetrics>();
	for (const m of sessionMetrics) sessionLookup.set(m.sessionId, m);

	// Stable order for deterministic reports.
	const ruleIds = [...byRule.keys()].sort();

	lines.push("### Hits by rule");
	lines.push("");
	lines.push("| Rule | Hits |");
	lines.push("|---|---:|");
	for (const id of ruleIds) {
		lines.push(`| \`${id}\` | ${byRule.get(id)!.length} |`);
	}
	lines.push("");

	// Per-rule detail: up to 10 sample hits per rule.
	for (const id of ruleIds) {
		const hits = byRule.get(id)!;
		lines.push(`### \`${id}\` — ${hits.length} hit${hits.length === 1 ? "" : "s"}`);
		lines.push("");
		const samples = hits.slice(0, 10);
		for (const h of samples) {
			const sess = sessionLookup.get(h.sessionId);
			const sessLabel = sess ? sess.sessionId.slice(0, 8) : h.sessionId.slice(0, 8);
			const filename = h.filePath.split("/").slice(-1)[0];
			lines.push(
				`- session \`${sessLabel}\` (\`${filename}\`) lines \`${h.lineRange[0]}-${h.lineRange[1]}\`: ${h.message}`,
			);
		}
		if (hits.length > samples.length) {
			lines.push(`- *(...${hits.length - samples.length} more hits omitted)*`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderOutcomes(_input: RenderInput): string {
	// Phase 5 will replace this. Until then we emit a placeholder so the
	// section headers in the report stay stable across phases.
	return [
		"## 4. Outcomes",
		"",
		"(not yet implemented — phase 5)",
		"",
	].join("\n");
}

function renderProposals(_input: RenderInput): string {
	return [
		"## 5. Propose",
		"",
		"(not requested — pass `--propose` to enable; phase 6)",
		"",
	].join("\n");
}

/**
 * Format a ratio for the markdown table. `null` becomes `n/a` so the
 * cell reads cleanly when the denominator was zero.
 */
function formatRatio(r: number | null): string {
	if (r === null) return "n/a";
	return r.toFixed(2);
}

function formatPercent(r: number | null): string {
	if (r === null) return "n/a";
	return `${(r * 100).toFixed(1)}%`;
}

function formatDate(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}
