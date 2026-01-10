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

2. Find all PRs with `drummer-merge` label:
   ```bash
   gh pr list --label drummer-merge --json number,title,headRefName,baseRefName,mergeable,additions,deletions
   ```
   **Only PRs with the `drummer-merge` label are eligible for merge.**
   This finds ALL labeled PRs, not just those for claimed tasks.

3. **Build dependency graph and identify stacks:**
   - Create adjacency list: `baseRefName → [PRs targeting it]`
   - Find root PRs: those where `baseRefName = main` (or master)
   - Identify stacks: chains where child PRs target parent PR branches
   - **Detect cycles**: If a branch eventually targets itself, report error and skip
   - Example graph:
     ```
     main ← PR #42 (ba/abc-123) ← PR #43 (ba/abc-456)
     main ← PR #44 (ba/xyz-789)  [separate stack]
     ```

4. **Select stack to process:**
   - If multiple independent stacks exist, pick first by lowest root PR number (FIFO by age)
   - If multiple PRs target the same base branch, order by PR number (lowest first)
   - Report other stacks as "queued for next run"
   - Process only one stack per invocation to keep merges atomic
   - **Orphaned children**: If a child PR targets a branch that doesn't exist (parent merged externally), update its base to main and treat as a root

5. **Batch review** - evaluate all PRs in the selected stack together:
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

6. **Merge stack in dependency order** (root first, then children):

   For each PR in the stack, starting from the root:

   a. **Verify CI is passing:**
      ```bash
      gh pr checks <pr-number> --fail-on-error
      ```
      If CI is failing, stop and report error.

   b. **Rebase onto its target branch:**
      ```bash
      git fetch origin
      gh pr checkout <pr-number>
      git rebase origin/<base-branch>  # main for root, parent branch for children
      ```

   c. If .ba/ conflict, resolve mechanically (each task = one line)

   d. Push rebased branch:
      ```bash
      git push --force-with-lease
      ```

   e. Squash merge:
      ```bash
      gh pr merge <pr-number> --squash
      ```

   f. **For child PRs in the stack** (after parent merged):
      - Update base branch to main:
        ```bash
        gh pr edit <child-pr-number> --base main
        ```
      - Rebase child onto main:
        ```bash
        gh pr checkout <child-pr-number>
        git rebase origin/main
        git push --force-with-lease
        ```
      - Force-push triggers new CI run; batch review + parent merge provides confidence
      - Now child PR targets main and is rebased, continue to merge it (step a-e)

   g. **Verify task closure** - After each merge:
      ```bash
      git pull origin main
      # Extract task ID from branch name: ba/abc-123 → abc-123
      # Note: Assumes branch follows ba/<task-id> convention from mouse skill
      task_id="${headRefName#ba/}"
      ba show $task_id  # Check status
      # If not closed, fix it:
      ba finish $task_id
      # If any fixes were needed:
      git add .ba/ && git commit -m "fix: close task ${task_id} after merge" && git push origin main
      ```
      Squash merge can lose .ba/ changes during conflict resolution.

   h. **On merge failure** - If any PR in the stack fails to merge:
      - Stop processing the stack
      - Report which PRs were merged successfully and which failed
      - Signal error: already-merged PRs stay merged, failed PR remains open
      - Next drummer run will see the failed PR as a new root (its parent is now in main)

7. **Signal completion (MANDATORY)** - This is the LAST thing you do:
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

When PRs target other PR branches (not main), drummer detects the stack and processes it:

**Detection:**
```bash
gh pr list --label drummer-merge --json number,title,headRefName,baseRefName,mergeable
```
- PRs with `baseRefName = main` are roots
- PRs with `baseRefName = ba/<task-id>` are children targeting that parent

**Graph building:**
```
adjacency[baseRefName] = [list of PRs targeting it]

Example:
  adjacency["main"] = [PR #42, PR #44]
  adjacency["ba/abc-123"] = [PR #43]

Stack 1: main ← #42 (ba/abc-123) ← #43 (ba/abc-456)
Stack 2: main ← #44 (ba/xyz-789)
```

**Merge sequence** (for Stack 1):
1. Merge #42 to main
2. Update #43: `gh pr edit 43 --base main`
3. Rebase #43 onto main: `git rebase origin/main && git push --force-with-lease`
4. Merge #43 to main

**After processing:**
```
Before:  PR #43 → ba/abc-123 → main
         PR #42 → main
         PR #44 → main (separate stack)

After:   PR #42 merged to main
         PR #43 rebased onto main, merged to main
         PR #44 remains for next drummer run
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

- **Success**: Selected stack fully merged → signal `status: "success"`
- **Partial success**: Some PRs in stack merged, then failure → signal `status: "error"` with details
- **Needs attention**: Batch review raised concerns - waiting for human decision (no signal - awaiting input)
- **Error**: Unrecoverable failure (code conflicts, CI failing, cycle detected) → signal `status: "error"` with message
- **No work**: No PRs with `drummer-merge` label found → signal `status: "success"` (nothing to do)

## Example

### Basic (no stacks)

```
$ /drummer

Finding PRs with drummer-merge label...
Found 2 PRs:
  PR #42 "Fix validation bug" → main (CI ✓)
  PR #44 "Refactor validator" → main (CI ✓)

Building dependency graph...
  Stack 1: main ← #42
  Stack 2: main ← #44
  2 independent stacks, processing Stack 1

Running batch review on Stack 1 (1 PR)...
Batch review complete: ✓ No issues

Processing PR #42 (Fix validation bug)...
  Verifying CI... ✓
  Rebasing onto main... clean
  Squash merging... ✓
  Verifying task closure... ✓

Merge complete.
  Merged: 1 PR (#42)
  Remaining: 1 PR (#44 - queued for next run)

Signaling completion...
Done.
```

### Stacked PRs

```
$ /drummer

Finding PRs with drummer-merge label...
Found 3 PRs:
  PR #42 "Fix validation bug" → main (CI ✓)
  PR #43 "Add edge case tests" → ba/abc-123 (CI ✓)
  PR #44 "Refactor validator" → main (CI ✓)

Building dependency graph...
  Stack 1: main ← #42 (ba/abc-123) ← #43 (ba/abc-456)
  Stack 2: main ← #44
  2 stacks found, processing Stack 1 (2 PRs)

Running batch review on Stack 1...
Collecting diffs: +547 -103 across 8 files
Batch review complete: ✓ No issues

Processing stack root: PR #42 (Fix validation bug)...
  Verifying CI... ✓
  Rebasing onto main... clean
  Squash merging... ✓
  Verifying task closure... ✓

Processing stack child: PR #43 (Add edge case tests)...
  Verifying CI... ✓
  Updating base branch to main... done
  Rebasing onto main... clean
  Conflict in .ba/issues.jsonl (expected)
  Resolving: keeping all task closures
  Squash merging... ✓
  Verifying task closure... ✓

Stack merged.
  Merged: 2 PRs (#42, #43)
  Remaining: 1 PR (#44 - queued for next run)

Signaling completion...
Done.
```
