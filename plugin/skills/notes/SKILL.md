---
name: notes
description: Address human PR comments, checkout branch, resolve feedback, push fixes
---

# Notes

Director's notes to ractors. Address human feedback on a PR - checkout branch, resolve comments, push fixes.

## Invocation

`/notes <pr-number>`

- `<pr-number>` - the pull request number to address comments on

## Prerequisites

- **Clean working tree**: No uncommitted changes (gh pr checkout may fail otherwise)
- **Repo context**: Run from the repo root where the PR exists
- **Not tracked as ba task**: This skill is ephemeral - it responds to feedback on an existing PR, not a new work item

## Flow

1. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```

2. Checkout the PR branch:
   ```bash
   gh pr checkout <pr-number>
   ```

3. Fetch PR comments (both top-level and inline review comments):
   ```bash
   gh pr view <pr-number> --json comments,reviews
   gh api repos/{owner}/{repo}/pulls/<pr-number>/comments
   ```

4. Identify unresolved human comments:
   - Filter out bot comments (CodeRabbit, etc.)
   - Focus on actionable feedback requiring code changes
   - Ignore resolved/outdated comments

5. For each unresolved comment:
   a. Understand the feedback
   b. Make the fix
   c. Stage changes (`git add`)
   d. Run `sg review` on staged changes
   e. Handle review findings:
      - P1-P3 trivial (one-liner fix): fix inline, re-stage, re-review
      - P1-P3 non-trivial (significant change): `ba create` as descendant task
      - P4: discard (nitpick)

6. **Complete ALL descendant tasks before commit.**
   Any `ba create` during this session = descendant that blocks push.

   Note: If feedback requires significant architectural changes, consider escalating
   back to the original task author rather than creating many descendant tasks.

   While ANY unclosed tasks created in this session:
   - `ba claim <next-task>`
   - Work until complete
   - Stage changes
   - Run `sg review` (each task gets its own review!)
   - Handle findings (may spawn more descendants)
   - `ba finish`, commit code + `.ba/`
   - Loop until zero unclosed descendants

7. Commit all fixes:
   ```bash
   git commit -m "address PR #<pr-number> feedback

   - <summary of each addressed comment>"
   ```

8. Push changes:
   ```bash
   git push
   ```

9. Reply to addressed comments (optional but helpful):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
     -f body="Fixed in $(git rev-parse --short HEAD)"
   ```

10. Exit and report:
   - List addressed comments
   - Note any unresolved items that need human decision
   - Provide PR URL

## Comment Handling

### Actionable Comments (address)
- "This should handle null case"
- "Missing error handling"
- "Variable name is confusing"
- "Add test for edge case"

### Non-Actionable (skip, report)
- Questions without clear ask: "Why did you do it this way?" (can address with code comment if helpful)
- Design debates: "Have you considered X approach?"
- Requests requiring human decision: "Should we use A or B?"

When in doubt, address it. Better to over-fix than under-fix.

## Review Handling

Same as mouse skill:
- **P1-P3 findings**: Create as ba tasks, work them in this session
- **P4 findings**: Discard as nitpicks (don't create tasks)

## Exit Conditions

- **Success**: All actionable comments addressed, changes pushed
- **Blocked**: Comment requires human decision - report and stop
- **Safety**: Max 10 task iterations (prevent runaway)

## Completion Signaling (MANDATORY)

**CRITICAL: You MUST signal completion when done.** This is the LAST thing you do.

```bash
# On success:
curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
  -H "Content-Type: application/json" \
  -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"success\", \"pr\": \"<PR-URL>\"}"

# On blocked (needs human):
curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
  -H "Content-Type: application/json" \
  -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"blocked\", \"blocker\": \"<reason>\"}"

# On error:
curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
  -H "Content-Type: application/json" \
  -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"error\", \"error\": \"<reason>\"}"
```

**If you don't signal, Miranda won't know you're done and the session becomes orphaned.**

## Example

```
$ /notes 42

Checking out PR #42...
Switched to branch 'ba/abc-123'

Fetching comments...
Found 4 comments:
  1. [human] "Add null check before accessing user.email" (line 45)
  2. [human] "This error message could be clearer" (line 72)
  3. [coderabbit] "Consider using optional chaining" → skipping (bot)
  4. [human] "Why not use the existing validate() function?" → needs decision

Addressing comment 1: Add null check...
Staging changes...
Running sg review...
No issues found.

Addressing comment 2: Improve error message...
Staging changes...
Running sg review...
No issues found.

Skipping comment 4: Requires human decision
  (Unsure whether to refactor to use validate() or keep current approach)

Committing fixes...
[ba/abc-123 a1b2c3d] address PR #42 feedback

  - Add null check before accessing user.email
  - Improve error message clarity

Pushing...
To github.com:org/repo.git
   f1e2d3c..a1b2c3d  ba/abc-123 -> ba/abc-123

Signaling blocked (comment 4 needs decision)...

Done.
  Addressed: 2 comments
  Skipped: 1 (bot comment)
  Blocked: 1 (comment about validate() function)

PR: https://github.com/org/repo/pull/42
```

### Success Example (no blockers)

```console
$ /notes 43

Checking out PR #43...
Fetching comments...
Found 2 comments:
  1. [human] "Fix typo in variable name" (line 12)
  2. [human] "Add logging here" (line 45)

Addressing comment 1: Fix typo...
Addressing comment 2: Add logging...
Committing fixes...
Pushing...

Signaling success...

Done.
  Addressed: 2 comments
  Blocked: 0

PR: https://github.com/org/repo/pull/43
```
