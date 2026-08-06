---
name: oh-plan
description: Create GitHub issues from task descriptions or session context. When Problem Weave is present, plan only selected S&T steps and preserve their lineage.
---

# oh-plan

Create GitHub issues ready for oh-task agents. The skill has two modes:

1. **Task mode**: Investigates codebase, asks clarifying questions, creates issues
2. **Session mode**: Reads existing `.oh/<session>.md` context, skips investigation, creates issues

## Invocation

```bash
# Task mode: investigate from scratch
/oh-plan "Add dark mode support to the dashboard"

# Session mode: use existing context from skills workflow
/oh-plan auth-refactor
```

## Mode Detection

At the start, check if the argument matches an existing session file:

```
If .oh/<arg>.md exists AND contains ## Solution Space:
    → Session mode (skip investigation, use context)
Else:
    → Task mode (investigate, ask questions)
```

## JIT References

If the session contains `## Problem Weave` or `### S&T Selection`,
load [references/open-horizons-session.md](references/open-horizons-session.md).
It defines the selection gate, issue hierarchy, S&T lineage block, session plan table, and workflow handoff.

## Session Mode Flow

When `.oh/<session>.md` exists with solution-space context:

1. **Read session file** and extract:
   - `## Aim` → Goal for issues
   - `## Problem Space` → Constraints, terrain, assumptions
   - `## Problem Weave` → Recursive S&T steps, sufficiency groups, lineage, owners, and wiring candidates
   - `## Solution Space` → Selected approach, trade-offs accepted
   - `## Problem Statement` → Framing (if present)

2. **Skip investigation** - context already gathered by grounding skills

3. **Skip clarifying questions** - decisions already made during solution-space

4. **Decompose the selected solution** into right-sized issues:
   - Start from the Solution Space recommendation
   - If Problem Weave exists, load the Open Horizons session reference and include only `selected` step IDs
   - Preserve the lineage fields named in that reference
   - Stop and report a planning gap when a selected child depends on an unselected parent or incomplete sufficiency group
   - Apply the decomposition rules below; aim for 1-4 hours of work per issue

5. **Choose issue hierarchy**:
   - One selected tactic that is independently deliverable → one issue
   - Several selected tactics under one objective → use the hierarchy rules in the Open Horizons session reference
   - Do not create an empty parent issue for a single tactic

6. **Create GitHub issues** from the session context:
   ```bash
   gh issue create --title "<title>" --label "oh-planned" --body "$(cat <<'EOF'
   ## Goal

   <from Aim section>

   ## Context

   <from Problem Space: constraints, terrain>
   <from Solution Space: selected approach>

   <if Problem Weave exists, insert the S&T Lineage block from the Open Horizons session reference>

   ## Acceptance Criteria

   - [ ] <derived from solution trade-offs>
   - [ ] <derived from aim feedback signals>

   ## Trade-offs Accepted

   <from Solution Space>

   ## Notes

   <from Problem Space assumptions>
   EOF
   )"
   ```

7. **Update the session file** with created issues. When Problem Weave exists, use the lineage table in the Open Horizons session reference.

### Session Mode Example

```
$ /oh-plan auth-refactor

Found session file: .oh/auth-refactor.md

Reading context...
- Aim: Users complete signup in under 60 seconds
- Problem: Current flow has 5 steps, competitors have 2
- Solution: Collapse to email + password, defer profile to post-signup
- Trade-offs: Less data upfront, need progressive profiling later

Decomposing into issues...

Created 2 issues:

#43: "Simplify signup to email + password only"
  - Remove name, company, role fields from signup
  - Add post-signup redirect to profile completion
  - Depends on: none

#44: "Add progressive profile completion flow"
  - Prompt for missing fields on first dashboard visit
  - Track completion percentage
  - Depends on: #43

Updated .oh/auth-refactor.md with issue links.
Done. Issues ready for /oh-task.
```

## Task Mode Flow

When no session file exists (current behavior):

1. **Explore the codebase** to understand:
   - Project architecture and patterns
   - Relevant files that would be touched
   - Existing similar implementations to follow
   - Potential complications or dependencies

2. **Ask clarifying questions** via AskUserQuestion:
   - Scope boundaries (what's in/out of scope)
   - Technical preferences (if multiple approaches exist)
   - Priority and any constraints
   - Only ask questions that affect the plan

3. **Assess complexity** and determine decomposition:
   - **Single coherent task** → create 1 issue
   - **Multiple independent pieces** → create multiple issues
   - **Large with dependencies** → create issues with "Depends on #N" links
   - Aim for issues that are 1-4 hours of work each

4. **Create GitHub issue(s)** with the `oh-planned` label:
   ```bash
   # Create label if it doesn't exist (one-time)
   gh label create oh-planned --description "Created via oh-plan skill" --color "0E8A16" 2>/dev/null || true

   # Create issue
   gh issue create --title "<clear, actionable title>" --label "oh-planned" --body "$(cat <<'EOF'
   ## Goal

   <1-2 sentences describing what we're trying to achieve>

   ## Context

   <relevant background - files identified, patterns to follow, constraints>

   ## Acceptance Criteria

   - [ ] Criterion 1 (specific, testable)
   - [ ] Criterion 2
   - [ ] Criterion 3

   ## Notes

   <any technical decisions, edge cases, or things to watch out for>
   EOF
   )"
   ```

5. **Signal completion**: Call `signal_completion(status: "success")` to notify the orchestrator.
   **Fallback:** If `signal_completion` is not available, output `COMPLETION: status=success` as your final message.

## Issue Quality Guidelines

Issues created by oh-plan should be:

- **Self-contained**: All context needed to start work without re-investigation
- **Actionable**: Clear title, specific acceptance criteria, "done" is obvious
- **Right-sized**: 1-4 hours of focused work (not too big, not trivial)
- **Linked**: Dependencies explicitly noted if multiple issues created
- **Traceable**: Session-mode issues retain selected S&T step ID, parent objective/step, sufficiency group, and acceptance signal

### Good Issue Title Examples

- "Add session timeout detection with configurable threshold"
- "Refactor user auth to use JWT instead of sessions"
- "Fix race condition in concurrent task spawning"

### Bad Issue Title Examples

- "Improve the code" (too vague)
- "Do the thing we discussed" (no context)
- "Bug fix" (what bug?)

## Decomposition Strategy

Prefer one focused issue per coherent change. Split only when the pieces can be tested independently; do not create trivial issues.

### When to Split

Split into multiple issues when ANY of these apply:

- **Multiple modules with distinct concerns** - Each coherent subsystem change can be its own issue
- **Mix of backend and frontend** - API changes and UI changes often work better as separate issues
- **Testable in isolation** - If parts can be tested independently, they're candidates for separate issues
- **Different risk profiles** - Risky changes shouldn't be bundled with straightforward ones

### When NOT to Split

Keep as one issue when:

- **Integration is trivial** - Just wiring things together with a few lines of code
- **Changes are tightly coupled** - Splitting would create issues that can't be tested alone
- **The "integration" is obvious** - No complex error handling, no new edge cases
- **Total scope is still reasonable** - Even combined, it's 2-4 hours of work

### Integration Issues

Consider a separate integration issue when connecting components involves:

- Non-trivial error handling at boundaries
- New edge cases that emerge from the combination
- Complex state coordination between systems
- A test surface that warrants explicit end-to-end coverage

**Don't** create integration issues for:
- Simple API calls with straightforward error handling
- Passing data from one component to another
- Standard CRUD wiring

**Pattern when integration IS complex:**
```
Issue #1: "Add theme persistence API" (Foundation)
Issue #2: "Add theme toggle component" (Feature)
Issue #3: "Wire theme system with fallback handling" (Integration - Depends on #1, #2)
  - Handle API failures gracefully
  - System preference detection fallback
  - Theme flicker prevention on load
```

### Decomposition Example

**Task:** "Add dark mode support to the dashboard"

**Over-decomposed (too many trivial issues):**
```
Issue #1: Add preferences API
Issue #2: Add toggle component
Issue #3: Add CSS variables
Issue #4: Wire toggle to API
Issue #5: Wire CSS to components
Issue #6: Handle loading states
```

**Under-decomposed (one big issue):**
```
Issue #1: Add dark mode support (everything)
```

**Right-sized:**
```
Issue #1: "Add user preferences API with theme support" (Foundation)
  - GET/POST /api/preferences
  - Includes theme field

Issue #2: "Add dark mode theming system" (Feature - Depends on #1)
  - CSS custom properties for light/dark
  - Theme toggle in settings
  - Wire to preferences API
  - Apply theme on app load

Issue #3: "Handle theme edge cases" (Polish - Depends on #2)
  - Only if complex: system preference fallback,
    theme flicker prevention, etc.
  - Skip if straightforward
```

### Dependency Notation

Use "Depends on #N" in issue body:
```
## Goal
Add dark mode theming system with toggle and persistence.

**Depends on:** #1 (preferences API)
```

## What NOT to Do

- Don't create issues for trivial changes (typo fixes, single-line changes)
- Don't over-decompose: 10 tiny issues are worse than 2-3 focused issues
- Don't start implementation: oh-plan is for planning only
- Don't skip the clarifying questions if scope is ambiguous (task mode)
- Don't re-investigate when session context exists (session mode)
- Don't create issues for Problem Weave tactics that Solution Space did not mark `selected`
- Don't drop S&T IDs or lineage when converting selected tactics into issues

## Exit Conditions

| Outcome | Call |
|---------|------|
| Issue(s) created successfully | `signal_completion(status: "success")` |
| User cancelled during questions | `signal_completion(status: "error", error: "User cancelled")` |
| Failed to create issue | `signal_completion(status: "error", error: "<reason>")` |
| Session file missing solution-space | `signal_completion(status: "error", error: "Session missing Solution Space - run /solution-space first")` |

## Task Mode Example

```
$ /oh-plan "Add heartbeat monitoring for tmux sessions"

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

Creating issue...

Created issue #67: "Add heartbeat monitoring for tmux sessions"

## Goal
Detect when tmux sessions stop responding and notify the user.

## Context
- Sessions are tracked in src/state/sessions.ts
- Tmux interactions in src/tmux/sessions.ts
- Need to add periodic check in main loop

## Acceptance Criteria
- [ ] Check session liveness every 30 seconds
- [ ] Mark session as "crashed" if not responding
- [ ] Send Telegram notification when session crashes
- [ ] Add crashed sessions to /status output

## Notes
- Use tmux has-session to check liveness
- Consider: what if tmux server itself is down?

signal_completion(status: "success")
Done. Issue #67 ready for /oh-task.
```

## Integration with Skills Workflow

When an Open Horizons session is present, load the session reference.
Grounding skills gather context; oh-plan turns selected work into traceable issues without repeating the investigation.
