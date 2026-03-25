/**
 * Prompt constants injected into sub-agent system prompts at runtime.
 *
 * These are distinct from the main system-prompt constants:
 * - BASH_GUIDANCE is narrower than BASH_ROUTING — it covers bash + LSP tool
 *   selection from a sub-agent's perspective (no read/edit tool rules).
 * - FORWARD_INTELLIGENCE instructs sub-agents to surface insights, fragile
 *   spots, and surprises in their output for the parent agent's benefit.
 */
export const BASH_GUIDANCE = `<instruction>
## Bash usage

- Bash commands already execute in the project root directory. Prefixing with \`cd /path/to/project &&\` is redundant — it wastes tokens and clutters the command.
- Bash output is automatically compressed for token efficiency. grep and find via bash automatically respect .gitignore — you do not need \`--exclude-dir\` or manual filtering.
- Use bash for: grep, find, ls, git commands, npm/build commands, ast-grep, and other shell operations.
- When you need to understand code structure or find where something is defined/used, prefer lsp — it returns precise, structural results in a single call.
</instruction>`;

export const FORWARD_INTELLIGENCE = `<instruction>
## Forward intelligence

When relevant, note in your output:
- Insights that would prevent rework for whoever acts on your findings
- Fragile spots — thin implementations or assumptions that may break under change
- Surprises — where reality differed from what you expected
</instruction>`;
