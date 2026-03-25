---
name: feature-dev
description: Guided feature development with codebase understanding and architecture focus
argument-hint: Optional feature description
---

# Feature Development

You are helping a developer implement a new feature. Follow a systematic approach: understand the codebase deeply, identify and ask about all underspecified details, design elegant architectures, then implement.

## Core Principles

- **Ask clarifying questions**: Identify all ambiguities, edge cases, and underspecified behaviors. Ask specific, concrete questions rather than making assumptions. Wait for user answers before proceeding with implementation. Ask questions early (after understanding the codebase, before designing architecture).
- **Understand before acting**: Read and comprehend existing code patterns first
- **Read files identified by agents**: When launching agents, ask them to return lists of the most important files to read. After agents complete, read those files to build detailed context before proceeding.
- **Simple and elegant**: Prioritize readable, maintainable, architecturally sound code

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built

Initial request: $ARGUMENTS

**Actions**:
1. If feature unclear, ask user for:
   - What problem are they solving?
   - What should the feature do?
   - Any constraints or requirements?
2. Summarize understanding and confirm with user

---

## Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns at both high and low levels

**Actions**:
1. Launch 2-3 code-explorer agents in parallel. Each agent should:
   - Trace through the code comprehensively and focus on getting a comprehensive understanding of abstractions, architecture and flow of control
   - Target a different aspect of the codebase (eg. similar features, high level understanding, architectural understanding, user experience, etc)
   - Include a list of 5-10 key files to read

   **Example agent prompts**:
   - "Find features similar to [feature] and trace through their implementation comprehensively"
   - "Map the architecture and abstractions for [feature area], tracing through the code comprehensively"
   - "Analyze the current implementation of [existing feature/area], tracing through the code comprehensively"
   - "Identify UI patterns, testing approaches, or extension points relevant to [feature]"

2. Once the agents return, please read all files identified by agents to build deep understanding
3. Present comprehensive summary of findings and patterns discovered

---

## Phase 3: Clarifying Questions

**Goal**: Fill in gaps and resolve all ambiguities before designing

**CRITICAL**: This is one of the most important phases. DO NOT SKIP.

**Actions**:
1. Review the codebase findings and original feature request
2. Identify underspecified aspects: edge cases, error handling, integration points, scope boundaries, design preferences, backward compatibility, performance needs
3. **Present all questions to the user in a clear, organized list**
4. **Wait for answers before proceeding to architecture design**

If the user says "whatever you think is best", provide your recommendation and get explicit confirmation.

---

## Phase 4: Architecture Design

**Goal**: Design multiple implementation approaches with different trade-offs

**Actions**:
1. Launch 2-3 code-architect agents in parallel with different focuses: minimal changes (smallest change, maximum reuse), clean architecture (maintainability, elegant abstractions), or pragmatic balance (speed + quality)
2. Review all approaches and form your opinion on which fits best for this specific task (consider: small fix vs large feature, urgency, complexity, team context)
3. Present to user: brief summary of each approach, trade-offs comparison, **your recommendation with reasoning**, concrete implementation differences
4. **Ask user which approach they prefer**

---

## Phase 5: Intent Documentation

**Goal**: Capture the full specification as a formal, reviewable document before any code is written

**CRITICAL**: Do not proceed to implementation without completing this phase and receiving user approval on the intent document.

**Actions**:
1. Compile the inputs for the intent document — synthesize from the previous phases:
   - Feature description from Phase 1
   - Clarification answers from Phase 3
   - Chosen architecture from Phase 4 (the user-approved approach)
2. Derive a filename slug from the feature description (lowercase, hyphens, 3-5 words) and generate a short UUID suffix (8 hex chars via `uuidgen | tr -d '-' | head -c8`). Example: `add-api-caching-a1b2c3d4.md`
3. Create `.intent/` directory if it doesn't exist (`mkdir -p .intent`)
4. Write `.intent/<slug>-<uuid>.md` using the intent document format below
5. Present the intent document to the user with a brief summary
6. **Wait for explicit user approval before proceeding**
   - If they request changes, update the document and re-present
   - If they approve, note the file path — it will be referenced during implementation and review

The intent document is the source of truth. If implementation decisions diverge from it, update the intent doc first.

**Intent Document Format**:

```markdown
# Intent: <Feature Title>

**Created**: <ISO date>
**ID**: <slug>-<uuid>

---

## Problem Statement
<One to three sentences. What problem does this solve and why it matters.>

## Scope

**In scope:**
- <Concrete item>

**Out of scope:**
- <Explicit exclusion to prevent scope creep>

## Requirements

### Functional Requirements
- FR-1: <Specific, testable requirement>
- FR-2: <Specific, testable requirement>

### Non-Functional Requirements
- NFR-1: <Performance, reliability, security, or UX requirement>

## Architectural Decisions

### Decision: <Short name>
**Chosen approach**: <What was decided>
**Rationale**: <Why this over alternatives>
**Trade-offs accepted**: <What we're giving up>

## Implementation Plan

### Files to Create
| File | Purpose |
|------|---------|
| `path/to/file` | <What it does> |

### Files to Modify
| File | Change |
|------|--------|
| `path/to/file` | <What changes and why> |

## Edge Cases and Error Handling
- **<Scenario>**: <Expected behavior>

## Constraints
- <Technical or scope constraint from clarification phase>
```

**Note**: The intent document path should be referenced in Phase 8 summary for future `/review-pr intent <path>` use. The `.intent/` directory and its files are ephemeral — clean them up after the PR is merged.

---

## Phase 6: Implementation

**Goal**: Build the feature

**DO NOT START WITHOUT USER APPROVAL ON THE INTENT DOCUMENT FROM PHASE 5**

**Actions**:
1. Wait for explicit user approval
2. Read all relevant files identified in previous phases
3. Implement following the chosen architecture and the approved intent document
4. Follow codebase conventions strictly
5. Write clean, well-documented code
6. If you need to deviate from the intent document, pause and note the deviation explicitly before proceeding

---

## Phase 7: Quality Review

**Goal**: Ensure code is simple, DRY, elegant, easy to read, functionally correct, and faithful to the intent document

**Actions**:
1. Launch review agents in parallel:
   - 3 code-reviewer agents with different focuses: simplicity/DRY/elegance, bugs/functional correctness, project conventions/abstractions
   - 1 `pr-review-toolkit:intent-reviewer` agent with the intent document path from Phase 5 — validates completeness, drift, fidelity, and out-of-scope violations
2. Consolidate findings from all agents and identify highest severity issues that you recommend fixing
3. **Present findings to user and ask what they want to do** (fix now, fix later, or proceed as-is)
4. Address issues based on user decision

---

## Phase 8: Summary

**Goal**: Document what was accomplished

**Actions**:
1. Summarize:
   - What was built
   - Key decisions made
   - Files modified
   - The intent document path (`.intent/<slug>-<uuid>.md`) for future `/review-pr intent` use
   - Suggested next steps

---
