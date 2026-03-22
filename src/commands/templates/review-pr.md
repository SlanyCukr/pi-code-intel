---
name: review-pr
description: Comprehensive PR review using specialized agents
argument-hint: "[review-aspects]"
---

# Comprehensive PR Review

Run a comprehensive pull request review using multiple specialized agents, each focusing on a different aspect of code quality.

**Review Aspects (optional):** "$ARGUMENTS"

## Review Workflow:

1. **Determine Review Scope**
   - Run `git diff --name-only` (against the base branch) to identify changed files
   - Parse arguments to see if the user requested specific review aspects
   - Default: Run all applicable reviews

2. **Available Review Aspects:**

   - **comments** — Analyze code comment accuracy and maintainability (agent: `pr-review-toolkit:comment-analyzer`)
   - **tests** — Review test coverage quality and completeness (agent: `pr-review-toolkit:pr-test-analyzer`)
   - **errors** — Check error handling for silent failures (agent: `pr-review-toolkit:silent-failure-hunter`)
   - **types** — Analyze type design and invariants (agent: `pr-review-toolkit:type-design-analyzer`)
   - **code** — General code review for project guidelines (agent: `pr-review-toolkit:code-reviewer`)
   - **simplify** — Simplify code for clarity and maintainability (agent: `pr-review-toolkit:code-simplifier`)
   - **all** — Run all applicable reviews (default)

3. **Identify Changed Files**
   - Run `git diff --name-only` to see modified files
   - Check if a PR already exists: `gh pr view` (if gh is available)
   - Identify file types and what reviews apply

4. **Determine Applicable Reviews**

   Based on the changes:
   - **Always applicable**: code-reviewer (general quality)
   - **If test files changed**: pr-test-analyzer
   - **If comments/docs added**: comment-analyzer
   - **If error handling changed**: silent-failure-hunter
   - **If types added/modified**: type-design-analyzer
   - **After passing review**: code-simplifier (polish and refine)

5. **Launch Review Agents**

   Use the agent tool to launch sub-agents. Include the git diff output in each agent's task prompt so it knows what changed.

   **Sequential approach** (default — one at a time):
   - Easier to understand and act on
   - Each report is complete before next

   **Parallel approach** (if user requests "parallel"):
   - Launch all agents simultaneously
   - Faster for comprehensive review

6. **Aggregate Results**

   After agents complete, summarize:

   ```markdown
   ## Critical Issues (X found)
   - [agent-name]: Issue description [file:line]

   ## Important Issues (X found)
   - [agent-name]: Issue description [file:line]

   ## Suggestions (X found)
   - [agent-name]: Suggestion [file:line]

   ## Strengths
   - What's well-done in this PR
   ```

7. **Provide Action Plan**

   Organize findings by priority:
   1. Fix critical issues first
   2. Address important issues
   3. Consider suggestions
   4. Re-run review after fixes

## Usage Examples:

**Full review (default):**
```
/review-pr
```

**Specific aspects:**
```
/review-pr tests errors
```

**Parallel review:**
```
/review-pr all parallel
```

## Tips:

- **Run early**: Before creating PR, not after
- **Focus on changes**: Agents analyze git diff by default
- **Address critical first**: Fix high-priority issues before lower priority
- **Re-run after fixes**: Verify issues are resolved
