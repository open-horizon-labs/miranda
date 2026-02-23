---
name: oh-conflict
description: Resolve merge conflicts on a PR by merging base into head
---

# oh-conflict

Resolve merge conflicts on a pull request. Work in an isolated worktree, merge the base branch into the PR head, resolve conflicts with understanding of both sides' intent, verify, and push.

## Invocation

`/oh-conflict <pr-number>`

- `<pr-number>` - the pull request number with merge conflicts

## Prerequisites

- **Repo context**: Run from the repo root where the PR exists
- **GitHub issue PR**: The PR should be from an oh-task session (branch `issue/<number>`)

## Flow

1. Read dive context (if available) for project background:
   ```bash
   cat .wm/dive_context.md 2>/dev/null || echo "No dive context"
   ```

2. Get PR branch info:
   ```bash
   # Save original directory for cleanup
   ORIGINAL_DIR=$(pwd)

   # Get head and base branch names
   PR_INFO=$(gh pr view <pr-number> --json headRefName,baseRefName)
   BRANCH=$(echo "$PR_INFO" | jq -r .headRefName)
   BASE=$(echo "$PR_INFO" | jq -r .baseRefName)
   ```

3. Create worktree and set up:
   ```bash
   git fetch origin
   git worktree add .worktrees/conflict-<pr-number> -B $BRANCH origin/$BRANCH
   cd .worktrees/conflict-<pr-number>
   sg init
   ```

4. Understand the PR's intent before merging:
   ```bash
   # Read the linked issue to understand what this PR is trying to do
   PARENT_ISSUE=${BRANCH#issue/}
   gh issue view $PARENT_ISSUE

   # See the PR's own changes (what this branch introduced)
   git log --oneline origin/$BASE..$BRANCH
   git diff origin/$BASE...$BRANCH --stat
   ```

5. Attempt the merge:
   ```bash
   git merge origin/$BASE --no-edit
   ```
   This will fail with conflict markers in affected files.

6. Resolve conflicts file by file:
   - For each conflicted file, read both sides:
     ```bash
     git diff --name-only --diff-filter=U  # List conflicted files
     ```
   - Understand the intent of BOTH sides:
     - **Ours (HEAD/PR branch)**: What did this PR change and why?
     - **Theirs (base branch)**: What changed on base since this PR branched?
   - Resolve by preserving the intent of both sides
   - If the PR's changes are superseded by base, accept theirs
   - If both sides changed the same logic, merge the intents
   - Stage each resolved file: `git add <file>`

7. After all conflicts resolved, verify:
   ```bash
   # Ensure no remaining conflict markers
   grep -rn '<<<<<<< ' --include='*.ts' --include='*.js' --include='*.rs' . || echo "No conflict markers"

   # Run project checks
   # For TypeScript projects:
   pnpm typecheck 2>&1 || true
   pnpm test 2>&1 || true

   # For Rust projects:
   cargo check 2>&1 || true
   cargo test 2>&1 || true
   ```
   Adapt commands to the project's build system.

8. If verification fails (e.g., type errors from merged code):
   - Fix the issues introduced by the merge
   - Stage fixes
   - Run `sg review` on staged changes
   - Handle review findings:
     - P1-P3 trivial: fix inline
     - P1-P3 non-trivial: create GitHub issue as descendant
     - P4: discard

9. Complete the merge commit:
   ```bash
   git commit --no-edit  # Uses the auto-generated merge commit message
   ```

10. Push:
    ```bash
    git push
    ```

11. Cleanup worktree:
    ```bash
    cd $ORIGINAL_DIR
    git worktree remove .worktrees/conflict-<pr-number>
    ```

12. Exit and report:
    - List conflicted files and how each was resolved
    - Note any verification issues encountered
    - Provide PR URL

## Conflict Resolution Strategy

### Simple cases (auto-resolve)
- **Import additions on both sides**: Keep both imports
- **Adjacent but non-overlapping changes**: Accept both
- **Lockfile conflicts** (package-lock.json, pnpm-lock.yaml, Cargo.lock): Accept base version, then regenerate:
  ```bash
  # Accept theirs for lockfiles
  git checkout --theirs pnpm-lock.yaml
  pnpm install
  git add pnpm-lock.yaml
  ```

### Complex cases (manual resolution)
- **Same function changed on both sides**: Read the issue to understand PR intent, merge logically
- **File moved on one side, edited on other**: Apply the edit to the moved file
- **Schema/type changes on both sides**: Merge the types, verify all consumers

### When to escalate
- **Architectural conflicts**: Both sides restructured the same module differently
- **Semantic conflicts**: No textual conflict but merged code is logically wrong
- Report as blocked with clear description of what needs human decision

## Descendant Issues

If `sg review` finds non-trivial issues during resolution:
```bash
PARENT_ISSUE=${BRANCH#issue/}
NEW_ISSUE=$(gh issue create \
  --title "Fix: <brief description>" \
  --body "Spawned from #${PARENT_ISSUE} during conflict resolution on PR #<pr-number>.

## Context
<what was found>

## Acceptance
- [ ] Fix applied
- [ ] Tests pass" \
  --assignee @me | grep -oE '[0-9]+$')
```

Complete ALL descendant issues before the final push.

## Exit Conditions

- **Success**: All conflicts resolved, verification passes, changes pushed
- **Blocked**: Conflict requires human architectural decision
- **Error**: Cannot resolve without breaking functionality

## Completion Signaling (MANDATORY)
**CRITICAL: You MUST signal completion when done.** Call the `signal_completion` tool as your FINAL action.
**Signal based on outcome:**
| Outcome | Call |
|---------|------|
| Conflicts resolved, pushed | `signal_completion(status: "success", pr: "<pr-url>")` |
| Needs human decision | `signal_completion(status: "blocked", blocker: "<reason>")` |
| Unrecoverable failure | `signal_completion(status: "error", error: "<reason>")` |
**If you do not signal, the orchestrator will not know you are done and the session becomes orphaned.**

**Fallback:** If the `signal_completion` tool is not available, output your completion status as your final message in the format: `COMPLETION: status=<status> pr=<url>` or `COMPLETION: status=<status> error=<reason>`.
