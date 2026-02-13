---
name: oh-task
description: Work a GitHub issue to completion in a branch, including review follow-ups, then PR for human review
---

# oh-task

Like mouse, but for GitHub issues instead of ba tasks. Claims an issue, works it to completion in an isolated branch, PR for human review.

## Invocation

`/oh-task <issue-number> [branch]`

- `<issue-number>` - the GitHub issue number (e.g., `123` or `#123`)
- `[branch]` - optional base branch (default: `origin/main`)

Use `[branch]` for stacked PRs where this issue depends on another in-flight PR.

## Flow

1. Determine the target branch:
   - If `[branch]` specified: use that branch (strip `origin/` prefix if present)
   - Otherwise: use `main`
2. Sync with target branch from origin:
   ```bash
   git fetch origin
   git checkout -B <target-branch> origin/<target-branch>
   ```
3. Fetch and validate issue:
   ```bash
   gh issue view <issue-number> --json number,title,body,state,assignees
   ```
   Abort if issue is closed or already assigned to someone else.
4. Claim issue (assign to self):
   ```bash
   gh issue edit <issue-number> --add-assignee @me
   ```
   No commit needed - state is on GitHub.
5. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```
6. Read and understand the issue:
   - Review issue title and body
   - Think through the approach
   - Ask clarifying questions if requirements are ambiguous
   - Only proceed when confident in the approach
7. Create worktree from base branch:
   ```bash
   git fetch origin
   git worktree add .worktrees/issue-<number> -b issue/<number> --no-track origin/<target-branch>
   cd .worktrees/issue-<number>
   sg init
   ```
8. Work until issue is resolved
9. Stage changes (`git add`)
10. Run code checks (cargo check, npm/pnpm build, go build, etc. based on project type).
    Fix any errors, re-stage, re-run until clean.
11. Run `sg review` on staged changes (do NOT use code-reviewer agent)
12. Handle review findings:
    - P1-P3 trivial: fix inline, re-stage, re-review
    - P1-P3 non-trivial: create child issue with `gh issue create --title "..." --body "Parent: #<issue-number>"`
    - P4: discard (nitpick)
13. Commit code changes
14. **CRITICAL: Complete ALL child issues before PR.**
    Any `gh issue create` during this session = child that blocks PR.
    No "follow-ups" - if you create it, you work it now.

    While ANY unclosed issues created in this session:
    - Claim: `gh issue edit <child-number> --add-assignee @me`
    - Work until complete
    - Stage changes
    - Run code checks, fix errors until clean
    - Run `sg review` (each issue gets its own review!)
    - Handle findings (may spawn more children)
    - Commit
    - Loop until zero unclosed children
15. ALL issues addressed -> push and create PR:
    ```bash
    git push -u origin issue/<number>
    gh pr create --base <target-branch> --title "<issue-title>" --body "$(cat <<'EOF'
    Closes #<issue-number>

    ## Also Closes
    - #<child-1>
    - #<child-2>

    ## Summary
    <brief description of changes>
    EOF
    )"
    ```
    The "Closes #N" syntax auto-closes issues when PR merges.
16. Wait for CodeRabbit review, then iterate:
    - `gh pr view <pr-number> --comments` to check for CodeRabbit feedback
    - Handle like sg findings:
      - Trivial: fix inline
      - Non-trivial: create child issue
      - Nits: ignore
    - For each fix or new issue:
      - Stage changes
      - Run code checks, fix errors until clean
      - Run `sg review` (CodeRabbit fixes get sg reviewed too!)
      - Handle any new findings
      - Commit
    - Push all changes
    - Repeat until CodeRabbit has no new comments
17. Return to main repo and cleanup worktree:
    ```bash
    git worktree remove .worktrees/issue-<number>
    ```
18. Exit and report PR URL

## Git Workflow

- Create isolated worktree in `.worktrees/issue-<number>`
- All work happens on `issue/<number>` branch
- Branch from main/master at start
- Each issue = one or more commits
- Keep commits focused and atomic
- PR encompasses entire issue tree (parent + children)
- Worktree cleaned up after PR created

## Review Handling

- **P1-P3 findings**: Create as GitHub issues, work them in this session
- **P4 findings**: Discard as nitpicks (don't create issues)

## Human Touchpoint

The PR is the **only** human review point.
Everything before is autonomous.

## Exit Conditions

- **Success**: PR created, all issues in tree will close on merge
- **Blocked**: An issue needs human decision - stop and report
- **Safety**: Max 10 issue iterations (prevent runaway)

## Example

```
$ /oh-task 42

Fetching issue #42...
Issue: "Fix validation bug in auth module"
State: open, unassigned

Claiming issue #42...
Assigned to @me

Reading dive context...
No dive context found.

Reading issue details...
Issue: Input validation fails silently on empty strings
Approach: Add explicit empty string check before processing
No clarifying questions needed, proceeding.

Creating worktree .worktrees/issue-42 on branch issue/42
Initializing superego...
Working on issue...
Staging changes...
Running sg review...
Found 2 issues:
  - P3: Add test for edge case -> non-trivial, created issue #43 (Parent: #42)
  - P4: Consider renaming variable -> discarded (nitpick)
Review clean (P3 spawned as issue, P4 discarded)
[commit] fix: validate input before processing

Working on child issue #43...
Claiming issue #43...
Staging changes...
Running sg review...
No issues found.
[commit] test: add edge case coverage

All issues complete.
Pushing issue/42...
Creating PR...
PR created: https://github.com/org/repo/pull/99
Body includes: Closes #42, Closes #43

Waiting for CodeRabbit review...
CodeRabbit found 2 issues:
  - "Add nil check before dereferencing" -> trivial, fixing inline
  - "Consider refactoring to reduce complexity" -> nit, ignoring
[commit] fix: add nil check per CodeRabbit
Pushing...
CodeRabbit review passed.

Returning to main repo...
Cleaning up worktree...
Done.
```

### Stacked PRs Example

```
$ /oh-task 42
# Claims issue #42 on main
# Creates PR #99: issue/42 -> main (Closes #42)

$ /oh-task 43 issue/42
# Checks out issue/42, claims issue #43
# Creates PR #100: issue/43 -> issue/42 (Closes #43)

$ /oh-task 44 issue/43
# Checks out issue/43, claims issue #44
# Creates PR #101: issue/44 -> issue/43 (Closes #44)

$ /drummer
# Merges in order: #99 -> main, rebases #100 -> main, rebases #101 -> main
```
