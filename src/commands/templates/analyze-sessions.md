---
name: analyze-sessions
description: Analyze pi sessions for code-search efficiency, anti-patterns, outcomes, and (optionally) prompt-amendment proposals
argument-hint: e.g. --since 7d, --propose, --session <uuid>
---

Run `node "$EXTENSION_DIST/analysis/cli-main.js" $ARGUMENTS` and present the resulting report.

After the script completes, summarize the top three actionable findings yourself — do not dump the full report verbatim. Focus on:
- The two ratios most out of proportion (read:lsp, grep:lsp).
- The single anti-pattern with the highest hit count.
- The most concrete proposed amendment if `--propose` was passed.

If the script wrote a report to disk, include the file path in your summary so the operator can open it directly.
