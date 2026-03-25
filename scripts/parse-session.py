#!/usr/bin/env python3
"""Parse pi agent JSONL session files into a token-efficient summary.

Usage:
    python scripts/parse-session.py <session.jsonl> [--subagents] [--tools-only] [--costs]

Outputs a structured summary suitable for LLM consumption:
- Session metadata (model, thinking level, cwd, duration)
- Conversation flow with tool calls (names + key args, not full content)
- Tool usage statistics
- Cost summary
- Subagent sessions (when --subagents and subagents/ dir exists)
"""

import json
import sys
import os
import glob
import argparse
from datetime import datetime
from collections import Counter


def parse_args():
    p = argparse.ArgumentParser(description="Parse pi agent session JSONL files")
    p.add_argument("session", help="Path to session .jsonl file")
    p.add_argument("--subagents", action="store_true", help="Also parse subagent sessions from subagents/ dir")
    p.add_argument("--tools-only", action="store_true", help="Only show tool call summary, skip conversation flow")
    p.add_argument("--costs", action="store_true", help="Show detailed cost breakdown per turn")
    return p.parse_args()


def load_entries(path):
    """Load all JSONL entries from a session file."""
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def extract_session_info(entries):
    """Extract header, model, and thinking level from entries."""
    header = None
    model = None
    provider = None
    thinking = None

    for e in entries:
        if e["type"] == "session":
            header = e
        elif e["type"] == "model_change":
            provider = e.get("provider")
            model = e.get("modelId")
        elif e["type"] == "thinking_level_change":
            thinking = e.get("thinkingLevel")

    return header, provider, model, thinking


def truncate(s, maxlen=120):
    """Truncate string with ellipsis."""
    if not s or len(s) <= maxlen:
        return s
    return s[:maxlen] + "..."


def extract_tool_calls(content):
    """Extract tool call summaries from assistant message content blocks."""
    calls = []
    if not isinstance(content, list):
        return calls
    for block in content:
        if block.get("type") == "toolCall":
            name = block.get("name", "?")
            args = block.get("arguments", {})
            # Summarize arguments: show key fields, truncate values
            summary_parts = []
            for k, v in args.items():
                val_str = str(v)
                summary_parts.append(f"{k}={truncate(val_str, 80)}")
            args_summary = ", ".join(summary_parts) if summary_parts else ""
            calls.append({"name": name, "id": block.get("id", ""), "args": args_summary})
    return calls


def extract_text(content):
    """Extract text from message content (string or block array)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if block.get("type") == "text" and block.get("text"):
                parts.append(block["text"])
        return "\n".join(parts)
    return ""


def format_conversation(entries, show_costs=False):
    """Format conversation flow as a readable summary."""
    lines = []
    msg_entries = [e for e in entries if e["type"] == "message"]

    for e in msg_entries:
        msg = e.get("message", {})
        role = msg.get("role", "?")

        if role == "user":
            text = extract_text(msg.get("content", ""))
            lines.append(f"\n## User")
            lines.append(truncate(text, 300))

        elif role == "assistant":
            content = msg.get("content", [])
            # Extract text blocks
            text = extract_text(content)
            tool_calls = extract_tool_calls(content)

            lines.append(f"\n## Assistant [{msg.get('model', '?')}]")
            if text:
                lines.append(truncate(text, 300))
            for tc in tool_calls:
                lines.append(f"  -> {tc['name']}({tc['args']})")

            if show_costs:
                usage = msg.get("usage", {})
                cost = usage.get("cost", {})
                if cost:
                    lines.append(f"  cost: ${cost.get('total', 0):.4f} (in={usage.get('input',0)} out={usage.get('output',0)} cache_r={usage.get('cacheRead',0)} cache_w={usage.get('cacheWrite',0)})")

            stop = msg.get("stopReason", "")
            if stop == "error":
                lines.append(f"  [ERROR: {msg.get('errorMessage', 'unknown')}]")

        elif role == "toolResult":
            tool_name = msg.get("toolName", "?")
            is_error = msg.get("isError", False)
            content_text = extract_text(msg.get("content", ""))
            status = "ERROR" if is_error else "ok"
            # For tool results, show just status and a brief preview
            preview = truncate(content_text, 150)
            lines.append(f"  <- {tool_name} [{status}]: {preview}")

        elif role == "compactionSummary":
            lines.append(f"\n## [Compaction] {truncate(msg.get('summary', ''), 200)}")

    return "\n".join(lines)


def compute_tool_stats(entries):
    """Compute tool usage statistics."""
    tool_counter = Counter()
    tool_errors = Counter()

    for e in entries:
        if e["type"] != "message":
            continue
        msg = e.get("message", {})

        if msg.get("role") == "assistant":
            for tc in extract_tool_calls(msg.get("content", [])):
                tool_counter[tc["name"]] += 1

        if msg.get("role") == "toolResult" and msg.get("isError"):
            tool_errors[msg.get("toolName", "?")] += 1

    return tool_counter, tool_errors


def compute_costs(entries):
    """Compute total costs from assistant messages."""
    total_cost = 0.0
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_write = 0
    turns = 0

    for e in entries:
        if e["type"] != "message":
            continue
        msg = e.get("message", {})
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("usage", {})
        cost = usage.get("cost", {})
        total_cost += cost.get("total", 0)
        total_input += usage.get("input", 0)
        total_output += usage.get("output", 0)
        total_cache_read += usage.get("cacheRead", 0)
        total_cache_write += usage.get("cacheWrite", 0)
        turns += 1

    return {
        "total_cost": total_cost,
        "total_input": total_input,
        "total_output": total_output,
        "total_cache_read": total_cache_read,
        "total_cache_write": total_cache_write,
        "turns": turns,
    }


def compute_duration(entries):
    """Compute session duration from first to last timestamp."""
    timestamps = []
    for e in entries:
        ts = e.get("timestamp")
        if ts:
            try:
                timestamps.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
            except (ValueError, TypeError):
                pass
    if len(timestamps) < 2:
        return None
    return timestamps[-1] - timestamps[0]


def format_session(path, entries, label="Main Session"):
    """Format a complete session summary."""
    header, provider, model, thinking = extract_session_info(entries)
    tool_counts, tool_errors = compute_tool_stats(entries)
    costs = compute_costs(entries)
    duration = compute_duration(entries)

    lines = []
    lines.append(f"# {label}")
    lines.append(f"File: {path}")
    if header:
        lines.append(f"CWD: {header.get('cwd', '?')}")
        lines.append(f"Session ID: {header.get('id', '?')}")
    lines.append(f"Model: {provider}/{model} | Thinking: {thinking}")
    if duration:
        mins = duration.total_seconds() / 60
        lines.append(f"Duration: {mins:.1f}min")
    lines.append(f"Turns: {costs['turns']} | Total cost: ${costs['total_cost']:.4f}")
    lines.append(f"Tokens — in: {costs['total_input']:,} out: {costs['total_output']:,} cache_read: {costs['total_cache_read']:,} cache_write: {costs['total_cache_write']:,}")

    # Tool usage
    lines.append(f"\n## Tool Usage")
    if tool_counts:
        for tool, count in tool_counts.most_common():
            err = tool_errors.get(tool, 0)
            err_str = f" ({err} errors)" if err else ""
            lines.append(f"  {tool}: {count}{err_str}")
    else:
        lines.append("  (no tool calls)")

    # Key tools check
    important_tools = {"lsp", "search_code", "search_docs"}
    used_important = important_tools & set(tool_counts.keys())
    missing_important = important_tools - set(tool_counts.keys())
    if missing_important:
        lines.append(f"\n  ** NOT USED: {', '.join(sorted(missing_important))}")
    if used_important:
        lines.append(f"  Used code-intel tools: {', '.join(sorted(used_important))}")

    return "\n".join(lines)


def main():
    args = parse_args()
    session_path = os.path.abspath(args.session)

    if not os.path.isfile(session_path):
        print(f"Error: {session_path} not found", file=sys.stderr)
        sys.exit(1)

    entries = load_entries(session_path)
    if not entries:
        print(f"Error: no entries in {session_path}", file=sys.stderr)
        sys.exit(1)

    # Main session summary
    print(format_session(session_path, entries))

    # Conversation flow (unless --tools-only)
    if not args.tools_only:
        print(f"\n## Conversation Flow")
        print(format_conversation(entries, show_costs=args.costs))

    # Subagent sessions
    if args.subagents:
        session_dir = os.path.dirname(session_path)
        subagents_dir = os.path.join(session_dir, "subagents")
        if os.path.isdir(subagents_dir):
            sub_files = sorted(glob.glob(os.path.join(subagents_dir, "*.jsonl")))
            if sub_files:
                print(f"\n{'='*60}")
                print(f"# Subagent Sessions ({len(sub_files)} found)")
                print(f"{'='*60}")
                for i, sf in enumerate(sub_files, 1):
                    sub_entries = load_entries(sf)
                    if sub_entries:
                        print(f"\n{format_session(sf, sub_entries, label=f'Subagent {i}')}")
                        if not args.tools_only:
                            print(f"\n## Conversation Flow")
                            print(format_conversation(sub_entries, show_costs=args.costs))
            else:
                print(f"\nNo subagent session files in {subagents_dir}")
        else:
            print(f"\nNo subagents/ directory found at {subagents_dir}")


if __name__ == "__main__":
    main()
