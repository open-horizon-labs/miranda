---
name: notes
description: Address PR comments in worktree, resolve feedback, push fixes
---

# Notes

Director's notes to ractors. Address feedback on a PR - work in isolated worktree, resolve comments, push fixes.

## Invocation

`/notes <pr-number>`

- `<pr-number>` - the pull request number to address comments on

## Prerequisites

- **Repo context**: Run from the repo root where the PR exists
- **Not tracked as ba task**: This skill is ephemeral - it responds to feedback on an existing PR, not a new work item

## Flow

1. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```

2. Get PR branch info and create worktree:
   ```bash
   # Save original directory for cleanup
   ORIGINAL_DIR=$(pwd)

   # Get the PR branch name
   BRANCH=$(gh pr view <pr-number> --json headRefName -q .headRefName)

   # Fetch and create worktree tracking the remote branch
   git fetch origin
   git worktree add .worktrees/pr-<pr-number> -B $BRANCH origin/$BRANCH
   cd .worktrees/pr-<pr-number>
   sg init
   ```
   Note: `-B $BRANCH` creates/resets the local branch to track origin.

3. Fetch PR comments (both top-level and inline review comments):
   ```bash
   gh pr view <pr-number> --json comments,reviews
   gh api repos/{owner}/{repo}/pulls/<pr-number>/comments
   ```

4. Identify unresolved comments:
   - Focus on actionable feedback requiring code changes
   - Ignore resolved/outdated comments
   - Skip non-actionable noise (e.g., "Thanks for the PR!")

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

10. Cleanup worktree:
    ```bash
    cd $ORIGINAL_DIR
    git worktree remove .worktrees/pr-<pr-number>
    ```

11. Exit and report:
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

## Example

```
$ /notes 42

Getting PR #42 info...
Branch: ba/abc-123

Creating worktree .worktrees/pr-42 on branch ba/abc-123
Initializing superego...

Fetching comments...
Found 4 comments:
  1. "Add null check before accessing user.email" (line 45)
  2. "This error message could be clearer" (line 72)
  3. [coderabbit] "Consider using optional chaining" (line 45)
  4. "Why not use the existing validate() function?" → needs decision

Addressing comment 1: Add null check...
Staging changes...
Running sg review...
No issues found.

Addressing comment 2: Improve error message...
Staging changes...
Running sg review...
No issues found.

Addressing comment 3: Use optional chaining...
Staging changes...
Running sg review...
No issues found.

Skipping comment 4: Requires human decision
  (Unsure whether to refactor to use validate() or keep current approach)

Committing fixes...
[ba/abc-123 a1b2c3d] address PR #42 feedback

  - Add null check before accessing user.email
  - Improve error message clarity
  - Use optional chaining per CodeRabbit suggestion

Pushing...
To github.com:org/repo.git
   f1e2d3c..a1b2c3d  ba/abc-123 -> ba/abc-123

Cleaning up worktree...

Done.
  Addressed: 3 comments
  Blocked: 1 (comment about validate() function)

PR: https://github.com/org/repo/pull/42
```

### Success Example (no blockers)

```console
$ /notes 43

Getting PR #43 info...
Branch: feature/add-caching

Creating worktree .worktrees/pr-43 on branch feature/add-caching
Initializing superego...

Fetching comments...
Found 2 comments:
  1. "Fix typo in variable name" (line 12)
  2. "Add logging here" (line 45)

Addressing comment 1: Fix typo...
Addressing comment 2: Add logging...
Committing fixes...
Pushing...

Cleaning up worktree...

Done.
  Addressed: 2 comments
  Blocked: 0

PR: https://github.com/org/repo/pull/43
```
