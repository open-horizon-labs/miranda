---
name: jira-plan
description: Create Jira subtasks from task descriptions or session context. Investigates when needed, skips when context exists.
---

# jira-plan

Creates well-structured Jira subtasks ready for autonomous agents. Works in two modes:

1. **Task mode**: Investigates codebase, asks clarifying questions, creates subtasks
2. **Session mode**: Reads existing `.oh/<session>.md` context, skips investigation, creates subtasks

## Prerequisites

This skill requires a Jira MCP server to be configured. At startup, verify the MCP is available:

```
Check for Jira MCP tools:
- jira_search or jira_search_issues
- jira_create_issue
- jira_get_issue

If tools are not available:
  → Exit with: "Jira MCP not configured. Add a Jira MCP server to use this skill."
```

## Invocation

```bash
# Task mode - investigate from scratch
/jira-plan PROJ-123 "Add dark mode support to the dashboard"

# Session mode - use existing context from skills workflow
/jira-plan PROJ-123 auth-refactor
```

**Arguments:**
- First argument: Parent issue key (e.g., `PROJ-123`) - subtasks will be created under this
- Second argument: Task description OR session name

## Mode Detection

At the start, check if the second argument matches an existing session file:

```
If .oh/<arg>.md exists AND contains ## Solution Space:
    → Session mode (skip investigation, use context)
Else:
    → Task mode (investigate, ask questions)
```

## Session Mode Flow

When `.oh/<session>.md` exists with solution-space context:

1. **Read session file** and extract:
   - `## Aim` → Goal for subtasks
   - `## Problem Space` → Constraints, terrain, assumptions
   - `## Solution Space` → Selected approach, trade-offs accepted
   - `## Problem Statement` → Framing (if present)

2. **Skip investigation** - context already gathered by grounding skills

3. **Skip clarifying questions** - decisions already made during solution-space

4. **Decompose the selected solution** into right-sized subtasks:
   - Use the Solution Space recommendation as the starting point
   - Apply standard decomposition heuristics (see below)
   - Aim for 1-4 hours of work per subtask

5. **Create Jira subtasks** with enriched context from session:
   ```
   Use Jira MCP to create subtask:

   Project: <extracted from parent issue>
   Parent: <parent issue key>
   Issue Type: Sub-task
   Summary: <clear, actionable title>
   Description:
     h2. Goal
     <from Aim section>

     h2. Context
     <from Problem Space: constraints, terrain>
     <from Solution Space: selected approach>

     h2. Acceptance Criteria
     * <derived from solution trade-offs>
     * <derived from aim feedback signals>

     h2. Trade-offs Accepted
     <from Solution Space>

     h2. Notes
     <from Problem Space assumptions>

   Labels: jira-planned
   ```

6. **Update session file** with created subtasks:
   ```markdown
   ## Plan
   **Updated:** <timestamp>
   **Subtasks:** PROJ-124, PROJ-125, PROJ-126
   ```

### Session Mode Example

```
$ /jira-plan PROJ-100 auth-refactor

Found session file: .oh/auth-refactor.md

Reading context...
- Aim: Users complete signup in under 60 seconds
- Problem: Current flow has 5 steps, competitors have 2
- Solution: Collapse to email + password, defer profile to post-signup
- Trade-offs: Less data upfront, need progressive profiling later

Decomposing into subtasks...

Created 2 subtasks under PROJ-100:

PROJ-101: "Simplify signup to email + password only"
  - Remove name, company, role fields from signup
  - Add post-signup redirect to profile completion
  - Blocked by: none

PROJ-102: "Add progressive profile completion flow"
  - Prompt for missing fields on first dashboard visit
  - Track completion percentage
  - Blocked by: PROJ-101

Updated .oh/auth-refactor.md with subtask links.
Done. Subtasks ready for execution.
```

## Task Mode Flow

When no session file exists:

1. **Get parent issue context** using Jira MCP:
   ```
   Use jira_get_issue to fetch parent issue details:
   - Summary and description
   - Project key
   - Existing subtasks (to avoid duplication)
   ```

2. **Explore the codebase** to understand:
   - Project architecture and patterns
   - Relevant files that would be touched
   - Existing similar implementations to follow
   - Potential complications or dependencies

3. **Ask clarifying questions** via AskUserQuestion:
   - Scope boundaries (what's in/out of scope)
   - Technical preferences (if multiple approaches exist)
   - Priority and any constraints
   - Only ask questions that genuinely affect the plan

4. **Assess complexity** and determine decomposition:
   - **Single coherent task** → create 1 subtask
   - **Multiple independent pieces** → create multiple subtasks
   - **Large with dependencies** → create subtasks with blocking links
   - Aim for subtasks that are 1-4 hours of work each

5. **Create Jira subtask(s)** with the `jira-planned` label:
   ```
   Use Jira MCP to create subtask:

   Project: <from parent issue>
   Parent: <parent issue key>
   Issue Type: Sub-task
   Summary: <clear, actionable title>
   Description:
     h2. Goal
     <1-2 sentences describing what we're trying to achieve>

     h2. Context
     <relevant background - files identified, patterns to follow, constraints>

     h2. Acceptance Criteria
     * Criterion 1 (specific, testable)
     * Criterion 2
     * Criterion 3

     h2. Notes
     <any technical decisions, edge cases, or things to watch out for>

   Labels: jira-planned
   ```

6. **Link dependencies** between subtasks:
   ```
   If subtask B depends on subtask A:
   Use Jira MCP to create link:
   - Type: "Blocks" or "is blocked by"
   - From: A
   - To: B
   ```

## Subtask Quality Guidelines

Subtasks created by jira-plan should be:

- **Self-contained**: All context needed to start work without re-investigation
- **Actionable**: Clear summary, specific acceptance criteria, "done" is obvious
- **Right-sized**: 1-4 hours of focused work (not too big, not trivial)
- **Linked**: Dependencies explicitly noted if multiple subtasks created

### Good Summary Examples

- "Add session timeout detection with configurable threshold"
- "Refactor user auth to use JWT instead of sessions"
- "Fix race condition in concurrent task spawning"

### Bad Summary Examples

- "Improve the code" (too vague)
- "Do the thing we discussed" (no context)
- "Bug fix" (what bug?)

## Decomposition Strategy

**Bias toward focused subtasks.** A well-scoped subtask that does one thing well is better than a multifaceted subtask that tries to do many things. When genuinely uncertain, prefer splitting - but don't create trivial subtasks.

### When to Split

Split into multiple subtasks when ANY of these apply:

- **Multiple modules with distinct concerns** - Each coherent subsystem change can be its own subtask
- **Mix of backend and frontend** - API changes and UI changes often work better as separate subtasks
- **Testable in isolation** - If parts can be tested independently, they're candidates for separate subtasks
- **Different risk profiles** - Risky changes shouldn't be bundled with straightforward ones

### When NOT to Split

Keep as one subtask when:

- **Integration is trivial** - Just wiring things together with a few lines of code
- **Changes are tightly coupled** - Splitting would create subtasks that can't be tested alone
- **The "integration" is obvious** - No complex error handling, no new edge cases
- **Total scope is still reasonable** - Even combined, it's 2-4 hours of work

### Decomposition Example

**Task:** "Add dark mode support to the dashboard"

**Over-decomposed (too many trivial subtasks):**
```
PROJ-101: Add preferences API
PROJ-102: Add toggle component
PROJ-103: Add CSS variables
PROJ-104: Wire toggle to API
PROJ-105: Wire CSS to components
PROJ-106: Handle loading states
```

**Under-decomposed (one big subtask):**
```
PROJ-101: Add dark mode support (everything)
```

**Right-sized:**
```
PROJ-101: "Add user preferences API with theme support" (Foundation)
  - GET/POST /api/preferences
  - Includes theme field

PROJ-102: "Add dark mode theming system" (Feature)
  - CSS custom properties for light/dark
  - Theme toggle in settings
  - Wire to preferences API
  - Apply theme on app load
  Blocked by: PROJ-101

PROJ-103: "Handle theme edge cases" (Polish)
  - Only if complex: system preference fallback,
    theme flicker prevention, etc.
  - Skip if straightforward
  Blocked by: PROJ-102
```

## Jira-Specific Considerations

### Issue Types

Always use `Sub-task` as the issue type. The parent issue should be a Story, Task, or Bug.

### Fields

Adapt to available Jira fields. Common optional fields:
- **Story Points**: If the project uses them, estimate based on complexity
- **Sprint**: Usually leave unassigned (let humans assign to sprints)
- **Components**: If the project uses them, select appropriate component
- **Fix Version**: Usually leave unassigned

### Description Formatting

Jira uses wiki markup, not Markdown:
- `h2.` for headers (not `##`)
- `*` for bold (not `**`)
- `* item` for bullets (not `- item`)
- `{code}...{code}` for code blocks (not triple backticks)

### Labels

Always add `jira-planned` label to identify subtasks created by this skill.

## What NOT to Do

- Don't create subtasks for trivial changes (typo fixes, single-line changes)
- Don't over-decompose - 10 tiny subtasks is worse than 2-3 well-scoped ones
- Don't start implementation - jira-plan is for planning only
- Don't skip the clarifying questions if scope is ambiguous (task mode)
- Don't re-investigate when session context exists (session mode)
- Don't guess at Jira project configuration - fetch from parent issue

## Exit Conditions

| Outcome | Signal |
|---------|--------|
| Subtask(s) created successfully | `status: "success"` |
| Jira MCP not available | `status: "error", error: "Jira MCP not configured"` |
| User cancelled during questions | `status: "error", error: "User cancelled"` |
| Failed to create subtask | `status: "error", error: "<reason>"` |
| Parent issue not found | `status: "error", error: "Parent issue not found"` |
| Session file missing solution-space | `status: "error", error: "Session missing Solution Space - run /solution-space first"` |

## Task Mode Example

```
$ /jira-plan PROJ-100 "Add heartbeat monitoring for tmux sessions"

Fetching parent issue PROJ-100...
Found: "Miranda remote orchestration improvements"
Project: PROJ

Exploring codebase...
Found relevant files:
- src/tmux/sessions.ts (session management)
- src/state/sessions.ts (session state tracking)
- src/index.ts (main loop)

I have a few questions to scope this correctly:

Q: What should happen when a session stops responding?
[1] Mark as crashed, notify user
[2] Auto-restart the session
[3] Just log and continue

User: 1

Q: How often should we check for heartbeats?
[1] Every 30 seconds (Recommended)
[2] Every minute
[3] Every 5 minutes

User: 1

Creating subtask...

Created PROJ-107: "Add heartbeat monitoring for tmux sessions"

h2. Goal
Detect when tmux sessions stop responding and notify the user.

h2. Context
- Sessions are tracked in src/state/sessions.ts
- Tmux interactions in src/tmux/sessions.ts
- Need to add periodic check in main loop

h2. Acceptance Criteria
* Check session liveness every 30 seconds
* Mark session as "crashed" if not responding
* Send Telegram notification when session crashes
* Add crashed sessions to /status output

h2. Notes
- Use tmux has-session to check liveness
- Consider: what if tmux server itself is down?

Labels: jira-planned

Done. PROJ-107 ready for execution.
```

## Integration with Skills Workflow

jira-plan works seamlessly with the Open Horizons skills workflow:

```bash
# Grounding phase (in skills workflow)
/aim auth-refactor
/problem-space auth-refactor
/solution-space auth-refactor

# Planning phase (jira-plan reads the context)
/jira-plan PROJ-100 auth-refactor    # Creates Jira subtasks from session

# Execution phase
# Work the subtasks via your preferred method
```

This avoids duplicating investigation work - the grounding skills gather context, jira-plan transforms it into trackable Jira subtasks.
