/**
 * Type definitions for pi session analysis.
 *
 * The pi-coding-agent session JSONL format is documented in
 * `node_modules/@mariozechner/pi-coding-agent/docs/session.md`. We narrow
 * that surface to the fields the analyzer actually reads — every other
 * field is tolerated but ignored.
 *
 * The analyzer processes entries in **file order** rather than walking the
 * leaf-to-root tree. We are measuring what the agent actually did, not
 * what made it into the final LLM context. If the agent explored a branch
 * and abandoned it, those tool calls still happened and still count.
 */

/**
 * Header is the first line of every session JSONL file.
 *
 * Fields beyond `cwd` and `timestamp` (e.g. `parentSession` for forked
 * sessions) are tolerated but unused.
 */
export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	cwd: string;
	timestamp: string; // ISO-8601
	parentSession?: string;
}

/**
 * A single tool call inside an assistant message's `content` array.
 * One assistant message may contain multiple toolCall blocks (parallel
 * calls), which the reader flattens into separate `tool_call` events.
 */
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Granular event consumed by metrics and pattern rules.
 *
 * Each event carries `lineNumber` (1-based JSONL line) so any rule that
 * flags a sequence can cite back to the file for human verification.
 *
 * `entryId` is the pi session entry id (8-char hex). For events derived
 * from a multi-block message (e.g. several toolCalls in one assistant
 * turn) every derived event shares the same `entryId`.
 */
export type AnalysisEvent =
	| ToolCallEvent
	| ToolResultEvent
	| UserMessageEvent
	| AssistantTextEvent
	| CompactionEvent
	| BranchSummaryEvent
	| SystemPromptCapturedEvent;

export interface AnalysisEventBase {
	entryId: string;
	lineNumber: number;
	timestamp: string;
}

export interface ToolCallEvent extends AnalysisEventBase {
	kind: "tool_call";
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultEvent extends AnalysisEventBase {
	kind: "tool_result";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/**
	 * Flattened text from all `text` content blocks. We don't try to
	 * preserve image blocks or details — analysis only cares about the
	 * textual surface (e.g. for matching error strings).
	 */
	contentText: string;
}

export interface UserMessageEvent extends AnalysisEventBase {
	kind: "user_message";
	/** Flattened text. Empty string if the message had only image content. */
	text: string;
}

export interface AssistantTextEvent extends AnalysisEventBase {
	kind: "assistant_text";
	text: string;
}

export interface CompactionEvent extends AnalysisEventBase {
	kind: "compaction";
	tokensBefore: number;
}

export interface BranchSummaryEvent extends AnalysisEventBase {
	kind: "branch_summary";
	/** Entry the branch diverged from. */
	fromId: string;
}

/**
 * The pi-code-intel extension records the rendered system prompt to a
 * `custom` entry on every `before_agent_start` whose hash differs from
 * the previous capture. Surfacing it as a first-class event lets the
 * analyzer ground propose-mode in what the agent actually saw at the
 * time, rather than the present-day source of `system-prompt.ts`.
 *
 * Only entries with `customType === "code-intel:system-prompt"` produce
 * this event. Other `custom` entries (from other extensions) are
 * tolerated and skipped, just like in the original reader.
 */
export interface SystemPromptCapturedEvent extends AnalysisEventBase {
	kind: "system_prompt_captured";
	/** The full rendered system prompt the LLM saw at this point in the session. */
	text: string;
	/** First 16 hex chars of sha256(text); used for dedupe and cross-referencing. */
	hash: string;
	/** ISO-8601 capture time (may differ slightly from the entry's outer timestamp). */
	capturedAt: string;
	/** Names of tools active when the prompt was captured. */
	activeTools: string[];
}

/**
 * Result of parsing one session file.
 *
 * `malformedLines` counts lines that failed JSON.parse OR lacked a
 * recognized `type`. They are skipped (with a warning to stderr) rather
 * than aborting the whole run — a single corrupted line in one of many
 * sessions should not derail an analysis sweep.
 */
export interface ParsedSession {
	header: SessionHeader;
	events: AnalysisEvent[];
	filePath: string;
	/** Total entries seen (including ignored types like `label`, `custom`). */
	totalEntries: number;
	malformedLines: number;
}

/**
 * One detection from an anti-pattern rule.
 *
 * Each hit carries enough information for a human to verify it without
 * the analyzer's involvement — they can open the JSONL file at the
 * cited line range and read the raw entries.
 */
export interface AntiPatternHit {
	/** Stable rule identifier (e.g. `read-twice-no-edit`). */
	ruleId: string;
	sessionId: string;
	filePath: string;
	/** Inclusive line range in the source JSONL, 1-based. */
	lineRange: [number, number];
	/** One-line human-readable description of this specific hit. */
	message: string;
}

/**
 * A detector function. Pure: takes events for ONE session, returns its
 * hits. No I/O, no shared mutable state — trivially unit-testable.
 */
export type AntiPatternRule = (
	session: ParsedSession,
) => AntiPatternHit[];
