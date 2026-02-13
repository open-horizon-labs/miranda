---
name: oh-notes
description: Address PR comments for GitHub issue PRs, resolve feedback, push fixes
---

# oh-notes

Like notes, but for PRs from oh-task (GitHub issues). Address feedback on a PR - work in isolated worktree, resolve comments, push fixes. Uses GitHub issues for descendant tasks instead of ba.

## Invocation

`/oh-notes <pr-number>`

- `<pr-number>` - the pull request number to address comments on

## Prerequisites

- **Repo context**: Run from the repo root where the PR exists
- **GitHub issue PR**: The PR should be from an oh-task session (branch `issue/<number>`)

## Flow

1. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```

2. Get PR branch info and create worktree:
   ```bash
   # Save original directory for cleanup
   ORIGINAL_DIR=$(pwd)

   # Get the PR branch name and linked issue
   BRANCH=$(gh pr view <pr-number> --json headRefName -q .headRefName)

   # Extract issue number from branch (issue/<number>)
   PARENT_ISSUE=${BRANCH#issue/}

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
      - P1-P3 non-trivial (significant change): create GitHub issue as descendant
      - P4: discard (nitpick)

   **Creating descendant issues** (instead of ba tasks):
   ```bash
   # Create issue linked to parent
   NEW_ISSUE=$(gh issue create \
     --title "Fix: <brief description>" \
     --body "Spawned from #${PARENT_ISSUE} during PR #<pr-number> review.

   ## Context
   <what sg review found>

   ## Acceptance
   - [ ] Fix applied
   - [ ] sg review passes" \
     --assignee @me | grep -oE '[0-9]+$')

   echo "Created descendant issue #${NEW_ISSUE}"
   ```

6. **Complete ALL descendant issues before commit.**
   Any GitHub issue created during this session = descendant that blocks push.

   Note: If feedback requires significant architectural changes, consider escalating
   back to the original task author rather than creating many descendant issues.

   While ANY unclosed issues created in this session:
   - Work on the fix (same worktree, same branch)
   - Stage changes
   - Run `sg review` (each issue gets its own review!)
   - Handle findings (may spawn more descendants)
   - Commit with "Fixes #<issue-number>" to auto-close
   - Loop until zero unclosed descendants

7. Commit all fixes:
   ```bash
   # If there are descendant issues to close, include them in commit
   git commit -m "address PR #<pr-number> feedback

   - <summary of each addressed comment>

   Fixes #<descendant-issue-1>
   Fixes #<descendant-issue-2>"
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

- **P1-P3 findings**: Create as GitHub issues, work them in this session
- **P4 findings**: Discard as nitpicks (don't create issues)

## Exit Conditions

- **Success**: All actionable comments addressed, changes pushed
- **Blocked**: Comment requires human decision - report and stop
- **Safety**: Max 10 issue iterations (prevent runaway)

## Example

```
$ /oh-notes 42

Getting PR #42 info...
Branch: issue/123
Parent issue: #123

Creating worktree .worktrees/pr-42 on branch issue/123
Initializing superego...

Fetching comments...
Found 4 comments:
  1. "Add null check before accessing user.email" (line 45)
  2. "This error message could be clearer" (line 72)
  3. [coderabbit] "Consider using optional chaining" (line 45)
  4. "Why not use the existing validate() function?" -> needs decision

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
[issue/123 a1b2c3d] address PR #42 feedback

  - Add null check before accessing user.email
  - Improve error message clarity
  - Use optional chaining per CodeRabbit suggestion

Pushing...
To github.com:org/repo.git
   f1e2d3c..a1b2c3d  issue/123 -> issue/123

Cleaning up worktree...

Done.
  Addressed: 3 comments
  Blocked: 1 (comment about validate() function)

PR: https://github.com/org/repo/pull/42
```

### With Descendant Issue

```
$ /oh-notes 43

Getting PR #43 info...
Branch: issue/456
Parent issue: #456

Creating worktree .worktrees/pr-43 on branch issue/456
Initializing superego...

Fetching comments...
Found 1 comment:
  1. "Add input validation" (line 12)

Addressing comment 1: Add input validation...
Staging changes...
Running sg review...

sg review found P2 issue:
  "Validation should also handle edge case X"

Creating descendant issue...
Created issue #457: "Fix: Handle validation edge case X"

Working on #457...
Making fix...
Staging...
Running sg review...
No issues found.

Committing all fixes...
[issue/456 b2c3d4e] address PR #43 feedback

  - Add input validation per review
  - Handle validation edge case X

  Fixes #457

Pushing...
Cleaning up worktree...

Done.
  Addressed: 1 comment
  Descendant issues closed: #457

PR: https://github.com/org/repo/pull/43
```
