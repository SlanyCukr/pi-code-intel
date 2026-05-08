---
name: read-session
description: Parse and summarize a pi agent JSONL session file
argument-hint: <path-to-session.jsonl> [--subagents] [--tools-only] [--costs]
---

Run `python3 $EXTENSION_DIST/scripts/parse-session.py $ARGUMENTS` and present the resulting summary.

Briefly explain the session's main intent, the most-used tools, any tool errors, and how the session ended (committed work / aborted / unfinished). Do not dump the entire output verbatim — extract the salient findings.
