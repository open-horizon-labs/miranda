---
name: oh-plan
description: Investigate a task, ask clarifying questions, and create well-structured GitHub issues ready for oh-task
---

# oh-plan

Takes a high-level task description, investigates the codebase, asks clarifying questions, and creates actionable GitHub issues ready for oh-task agents.

## Invocation

`/oh-plan "<task description>"`

Example: `/oh-plan "Add dark mode support to the dashboard"`

## Flow

1. **Explore the codebase** to understand:
   - Project architecture and patterns
   - Relevant files that would be touched
   - Existing similar implementations to follow
   - Potential complications or dependencies

2. **Ask clarifying questions** via AskUserQuestion:
   - Scope boundaries (what's in/out of scope)
   - Technical preferences (if multiple approaches exist)
   - Priority and any constraints
   - Only ask questions that genuinely affect the plan

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

5. **Signal completion** (if `$MIRANDA_PORT` is set):
   ```bash
   curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
     -H "Content-Type: application/json" \
     -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"success\"}"
   ```

## Issue Quality Guidelines

Issues created by oh-plan should be:

- **Self-contained**: All context needed to start work without re-investigation
- **Actionable**: Clear title, specific acceptance criteria, "done" is obvious
- **Right-sized**: 1-4 hours of focused work (not too big, not trivial)
- **Linked**: Dependencies explicitly noted if multiple issues created

### Good Issue Title Examples

- "Add session timeout detection with configurable threshold"
- "Refactor user auth to use JWT instead of sessions"
- "Fix race condition in concurrent task spawning"

### Bad Issue Title Examples

- "Improve the code" (too vague)
- "Do the thing we discussed" (no context)
- "Bug fix" (what bug?)

## Decomposition Strategy

**Bias toward focused issues.** A well-scoped issue that does one thing well is better than a multifaceted issue that tries to do many things. When genuinely uncertain, prefer splitting - but don't create trivial issues.

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
- A meaningful test surface (end-to-end flows worth testing explicitly)

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
- Don't over-decompose - 10 tiny issues is worse than 2-3 well-scoped ones
- Don't start implementation - oh-plan is for planning only
- Don't skip the clarifying questions if scope is ambiguous

## Exit Conditions

| Outcome | Signal |
|---------|--------|
| Issue(s) created successfully | `status: "success"` |
| User cancelled during questions | `status: "error", error: "User cancelled"` |
| Failed to create issue | `status: "error", error: "<reason>"` |

## Example Session

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

Signaling completion...
Done. Issue #67 ready for /oh-task.
```
