---
name: drummer
description: Review and merge open PRs for claimed ba tasks as a cohesive batch
---

# Drummer

The collective that processes in rhythm. Holistically review pending PRs, then squash-merge them as a cohesive batch.

## Invocation

`/drummer`

## Flow

1. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```
   This provides architecture decisions, conventions, and session intent.
2. Find claimed tasks:
   ```bash
   ba list --status=in_progress
   ```

3. For each claimed task, find its PR with `drummer-merge` label:
   ```bash
   gh pr list --head ba/<task-id> --label drummer-merge --json number,title,mergeable,additions,deletions,labels
   ```
   **Only PRs with the `drummer-merge` label are eligible for merge.**
   Skip PRs without this label and report them as "awaiting human approval".

4. **Batch review** - evaluate all PRs together:
   - Collect combined diff of all PRs against main
   - Run `sg review` on the combined changes
   - Evaluate:
     - Do changes conflict logically? (same code modified differently)
     - Is there duplicate work? (two PRs solving same problem)
     - Do changes compose well? (feature A + feature B = coherent whole)
     - Any cross-cutting concerns? (shared dependencies, API changes)
   - If concerns found:
     - Report issues
     - Ask human whether to proceed or address first

5. For each PR (in dependency order):
   - Rebase onto latest main:
     ```bash
     git fetch origin
     gh pr checkout <pr-number>
     git rebase origin/main
     ```
   - If .ba/ conflict, resolve mechanically (each task = one line)
   - Push rebased branch:
     ```bash
     git push --force-with-lease
     ```
   - Squash merge:
     ```bash
     gh pr merge <pr-number> --squash
     ```
   - **Verify task closure** - After merge, ensure all tasks from this PR are closed:
     ```bash
     git pull origin main
     for task_id in <tasks-from-pr>; do
       ba show $task_id  # Check status
       # If not closed, fix it:
       ba finish $task_id
     done
     # If any fixes were needed:
     git add .ba/ && git commit -m "fix: close tasks after merge" && git push origin main
     ```
     Squash merge can lose .ba/ changes during conflict resolution. This step ensures
     all merged tasks end in closed state regardless of what the merge preserved.

6. **Signal completion (MANDATORY)** - This is the LAST thing you do:
   ```bash
   # On success:
   curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
     -H "Content-Type: application/json" \
     -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"success\"}"

   # On error:
   curl -sS -X POST "http://localhost:${MIRANDA_PORT}/complete" \
     -H "Content-Type: application/json" \
     -d "{\"session\": \"$TMUX_SESSION\", \"status\": \"error\", \"error\": \"<reason>\"}"
   ```
   **If you don't signal, Miranda won't know you're done and the session becomes orphaned.**

## Stacked PRs

When PRs target other PRs (not main), drummer detects the stack and merges in order:

1. Find root PRs (target main)
2. Merge root PR
3. Rebase child PRs onto main, update their target to main
4. Repeat until stack is flattened

```
Before:  PR #43 → ba/abc-123 → main
         PR #42 → main

After:   PR #42 merged to main
         PR #43 rebased onto main, merged to main
```

## Batch Review Criteria

The holistic review checks what individual PR reviews can't:

- **Logical conflicts**: PR A assumes X, PR B assumes not-X
- **Duplication**: Both PRs add similar functionality
- **Integration issues**: Combined changes break something neither breaks alone
- **Ordering dependencies**: PR B depends on PR A being merged first (auto-detected for stacked PRs)
- **Scope creep**: Batch as a whole does more than originally intended

## Conflict Resolution

`.ba/issues.jsonl` is line-per-task:
- Each line is independent
- Resolution: union of all lines (dedupe by task ID)
- Never lose a task closure

## Prerequisites

- PRs must have the `drummer-merge` label (human approval gate)
- PRs must have CI passing
- No code conflicts (only .ba/ conflicts handled automatically)
- Batch review must pass (or human override)

**Note:** The `drummer-merge` label must be created in the repo. This is opt-in per repo.

## Exit Conditions

- **Success**: All eligible PRs reviewed and merged → signal `status: "success"`
- **Needs attention**: Batch review raised concerns - waiting for human decision (no signal - awaiting input)
- **Error**: Unrecoverable failure (code conflicts, CI failing, etc.) → signal `status: "error"` with message

## Example

```
$ /drummer

Finding claimed tasks...
Found 3 in_progress tasks: abc-123, abc-456, abc-789

Checking for open PRs with drummer-merge label...
  abc-123: PR #42 "Fix validation bug" (CI ✓, drummer-merge ✓)
  abc-456: PR #43 "Add edge case tests" (CI ✓, drummer-merge ✓)
  abc-789: PR #44 "Refactor validator" (CI ✓) ⏳ awaiting approval

Running batch review on combined changes...
Collecting diffs: +847 -203 across 12 files

Batch review complete:
  ✓ No logical conflicts
  ✓ No duplication
  ⚠ Ordering dependency: PR #44 (refactor) should merge before PR #42 (fix)

Reordering merge sequence: #44 → #42 → #43

Processing PR #44 (Refactor validator)...
  Rebasing onto main... clean
  Squash merging... ✓

Processing PR #42 (Fix validation bug)...
  Rebasing onto main... clean
  Squash merging... ✓

Processing PR #43 (Add edge case tests)...
  Rebasing onto main...
  Conflict in .ba/issues.jsonl (expected)
  Resolving: keeping all task closures
  Squash merging... ✓

Merge train complete.
  Merged: 2 PRs (#42, #43)
  Skipped: 1 PR (#44 - awaiting drummer-merge label)

Signaling completion...
Done.
```
