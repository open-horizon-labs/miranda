---
name: mouse
description: Work a ba task to completion in a branch, including review follow-ups, then PR for human review
---

# Mouse

A small autonomous worker from the Mouse Army. Claims a task, works it to completion in an isolated branch, PR for human review.

## Invocation

`/mouse <task-id> [--base <branch>]`

- `<task-id>` - the ba task to work on
- `--base <branch>` - optional base branch (default: `origin/main`)

Use `--base` for stacked PRs where this task depends on another in-flight PR.

## Flow

1. Pull latest changes:
   ```bash
   git fetch origin
   git pull origin main  # or <base-branch> if using --base
   ```
2. `ba claim <task-id> --session $$`
3. Commit and push claim to main (makes claim visible to other workers):
   ```bash
   git add .ba/
   git commit -m "claim: <task-id>"
   git push origin main
   ```
4. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```
   This provides architecture decisions, conventions, and session intent.
5. Read and understand the task:
   - `ba show <task-id>` to get full details
   - Think through the approach
   - Ask clarifying questions if requirements are ambiguous
   - Only proceed when confident in the approach
6. Create worktree from base branch:
   ```bash
   git fetch origin
   git worktree add .worktrees/<task-id> -b ba/<task-id> --no-track <base-branch>
   cd .worktrees/<task-id>
   sg init
   ```
   Where `<base-branch>` is `--base` argument or `origin/main` if not specified.
7. Work until task is complete
8. Stage changes (`git add`)
9. Run `sg review` on staged changes (do NOT use code-reviewer agent)
10. Handle review findings:
   - P1-P3 trivial: fix inline, re-stage, re-review
   - P1-P3 non-trivial: `ba create` as descendant task
   - P4: discard (nitpick)
11. `ba finish <task-id>`
12. Commit code + `.ba/` changes together (task closure travels with code)
13. **CRITICAL: Complete ALL descendant tasks before PR.**
    Any `ba create` during this session = descendant that blocks PR.
    No "follow-ups" - if you create it, you work it now.

    While ANY unclosed tasks created in this session:
    - `ba claim <next-task>`
    - Work until complete
    - Stage changes
    - Run `sg review` (each task gets its own review!)
    - Handle findings (may spawn more descendants)
    - `ba finish`, commit code + `.ba/`
    - Loop until zero unclosed descendants
14. ALL tasks closed → push and create PR:
    ```bash
    git push -u origin ba/<task-id>
    gh pr create --base <base-branch> --title "<original-task-title>" --body "$(cat <<'EOF'
    ## Completed Tasks
    - <task-id>: <title>
    - <descendant-1>: <title>
    - ...

    ## Summary
    <brief description of changes>
    EOF
    )"
    ```
    Where `--base` is `main` (default) or the branch specified via `--base` arg.
    For stacked PRs, this creates a chain: task-2 PR targets ba/task-1, etc.
15. Wait for CodeRabbit review, then iterate:
    - `gh pr view <pr-number> --comments` to check for CodeRabbit feedback
    - Handle like sg findings:
      - Trivial: fix inline
      - Non-trivial: `ba create` as descendant
      - Nits: ignore
    - For each fix or new task:
      - Stage changes
      - Run `sg review` (CodeRabbit fixes get sg reviewed too!)
      - Handle any new findings (may spawn more descendants)
      - `ba finish` if task, commit code + `.ba/`
    - Push all changes
    - Repeat until CodeRabbit has no new comments
16. Cleanup worktree:
    ```bash
    cd <original-dir>
    git worktree remove .worktrees/<task-id>
    ```
17. Signal completion to Miranda (if `$MIRANDA_PORT` is set):
    ```bash
    curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
      -H "Content-Type: application/json" \
      -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"success\", \"pr\": \"<pr-url>\"}"
    ```
18. Exit and report PR URL

## Git Workflow

- Create isolated worktree in `.worktrees/<task-id>`
- All work happens on `ba/<task-id>` branch
- Branch from main/master at start
- Each task completion = one or more commits
- Keep commits focused and atomic
- PR encompasses entire task tree
- Worktree cleaned up after PR created

## Review Handling

- **P1-P3 findings**: Create as ba tasks, work them in this session
- **P4 findings**: Discard as nitpicks (don't create tasks)

## Human Touchpoint

The PR is the **only** human review point.
Everything before is autonomous.

## Exit Conditions

- **Success**: PR created, all tasks in tree closed
- **Blocked**: A task needs human decision - stop and report
- **Safety**: Max 10 task iterations (prevent runaway)

## Completion Signaling (MANDATORY)

**CRITICAL: You MUST signal completion when done.** If `$MIRANDA_PORT` is set, you are running under Miranda and MUST curl the completion endpoint. This is the LAST thing you do.

```bash
# Run this as your FINAL action:
curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
  -H "Content-Type: application/json" \
  -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"success\", \"pr\": \"<pr-url>\"}"
```

**Signal based on outcome:**
| Outcome | Status | Payload |
|---------|--------|---------|
| PR created & reviewed | `success` | `"pr": "<url>"` |
| Unrecoverable failure | `error` | `"error": "<reason>"` |
| Needs human decision | `error` | `"error": "Blocked: <reason>"` |

**If you don't signal, Miranda won't know you're done and the session becomes orphaned.**

## Example

```
$ /mouse abc-123

Claiming abc-123: "Fix validation bug"
Pushing claim to main...
Reading task details...
Task: Input validation fails silently on empty strings
Approach: Add explicit empty string check before processing
No clarifying questions needed, proceeding.

Creating worktree .worktrees/abc-123 on branch ba/abc-123
Initializing superego...
Working on task...
Staging changes...
Running sg review...
Found 2 issues:
  - P3: Add test for edge case → non-trivial, created abc-456
  - P4: Consider renaming variable → discarded (nitpick)
Review clean (P3 spawned as task, P4 discarded)
Finished abc-123
[commit] fix: validate input before processing (includes .ba/ closure)

Working on descendant abc-456...
Staging changes...
Running sg review...
No issues found.
Finished abc-456
[commit] test: add edge case coverage (includes .ba/ closure)

All tasks complete.
Pushing ba/abc-123...
Creating PR...
PR created: https://github.com/org/repo/pull/42

Waiting for CodeRabbit review...
CodeRabbit found 2 issues:
  - "Add nil check before dereferencing" → trivial, fixing inline
  - "Consider refactoring to reduce complexity" → nit, ignoring
[commit] fix: add nil check per CodeRabbit
Pushing...
CodeRabbit review passed.

Cleaning up worktree...
Signaling completion to Miranda...
Done.
```

### Stacked PRs Example

```
$ /mouse abc-123
# Creates PR #42: ba/abc-123 → main

$ /mouse abc-456 --base ba/abc-123
# Creates PR #43: ba/abc-456 → ba/abc-123

$ /mouse abc-789 --base ba/abc-456
# Creates PR #44: ba/abc-789 → ba/abc-456

$ /drummer
# Merges in order: #42 → main, rebases #43 → main, rebases #44 → main
```
