---
name: oh-ci
description: Diagnose and fix CI failures on a PR, push fixes
---

# oh-ci

Fix CI failures on a pull request. Work in an isolated worktree, diagnose failures from check run logs, apply fixes, verify, and push.

## Invocation

`/oh-ci <pr-number>`

- `<pr-number>` - the pull request number with failing CI

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

   # Get the PR branch name
   BRANCH=$(gh pr view <pr-number> --json headRefName -q .headRefName)

   # Fetch and create worktree tracking the remote branch
   git fetch origin
   git worktree add .worktrees/ci-<pr-number> -B $BRANCH origin/$BRANCH
   cd .worktrees/ci-<pr-number>
   sg init
   ```

3. Fetch CI check run details and logs:
   ```bash
   # Get the head SHA
   HEAD_SHA=$(gh pr view <pr-number> --json headRefName,commits -q '.commits[-1].oid')

   # List all check runs for this commit
   gh api repos/{owner}/{repo}/commits/${HEAD_SHA}/check-runs --jq '.check_runs[] | select(.conclusion == "failure") | {name: .name, id: .id, conclusion: .conclusion}'

   # For each failed check run, get the log
   gh api repos/{owner}/{repo}/check-runs/{check_run_id}/annotations
   ```

   If check run logs are insufficient, also try:
   ```bash
   # Get workflow run logs (GitHub Actions)
   gh run view --log-failed
   ```

4. Diagnose failures:
   - Parse the CI logs to identify the root cause
   - Common categories: type errors, test failures, lint violations, build errors
   - If multiple failures, identify if they share a root cause
   - Read the relevant source files to understand context

5. Fix the code:
   - Apply targeted fixes for each failure
   - Stage changes (`git add`)
   - Run `sg review` on staged changes
   - Handle review findings:
     - P1-P3 trivial: fix inline, re-stage
     - P1-P3 non-trivial: create GitHub issue as descendant
     - P4: discard

6. Verify the fix locally:
   ```bash
   # Run the same checks that failed, if possible
   # For TypeScript projects:
   pnpm typecheck 2>&1 || true
   pnpm test 2>&1 || true
   pnpm lint 2>&1 || true

   # For Rust projects:
   cargo check 2>&1 || true
   cargo test 2>&1 || true
   cargo clippy 2>&1 || true
   ```
   Adapt commands to the project's build system (check package.json scripts, Makefile, etc.).

7. Commit fixes:
   ```bash
   git commit -m "fix: resolve CI failures on PR #<pr-number>

   - <summary of each fix>

   Fixes #<descendant-issue> (if any)"
   ```

8. Push:
   ```bash
   git push
   ```

9. Cleanup worktree:
   ```bash
   cd $ORIGINAL_DIR
   git worktree remove .worktrees/ci-<pr-number>
   ```

10. Exit and report:
    - List what CI checks were failing and what was fixed
    - Note any remaining issues that need human attention
    - Provide PR URL

## Descendant Issues

If `sg review` finds non-trivial issues during the fix, create GitHub issues:
```bash
PARENT_ISSUE=${BRANCH#issue/}
NEW_ISSUE=$(gh issue create \
  --title "Fix: <brief description>" \
  --body "Spawned from #${PARENT_ISSUE} during CI fix on PR #<pr-number>.

## Context
<what was found>

## Acceptance
- [ ] Fix applied
- [ ] CI passes" \
  --assignee @me | grep -oE '[0-9]+$')
```

Complete ALL descendant issues before the final push.

## Failure Modes

- **Flaky tests**: If a test failure appears non-deterministic, note it and push anyway. Report as "potentially flaky" in completion.
- **Infrastructure failures**: If CI failed due to infra (runner OOM, timeout, service outage), report as blocked — no code fix possible.
- **Dependency issues**: If a transitive dependency broke, attempt version pin or update. If not feasible, report as blocked.

## Exit Conditions

- **Success**: All CI failures diagnosed and fixed, changes pushed
- **Blocked**: Failure requires human decision or is infrastructure-related
- **Error**: Cannot diagnose the failure or fix creates worse problems

## Completion Signaling (MANDATORY)
**CRITICAL: You MUST signal completion when done.** Call the `signal_completion` tool as your FINAL action.
**Signal based on outcome:**
| Outcome | Call |
|---------|------|
| CI fixed, changes pushed | `signal_completion(status: "success", pr: "<pr-url>")` |
| Needs human decision | `signal_completion(status: "blocked", blocker: "<reason>")` |
| Unrecoverable failure | `signal_completion(status: "error", error: "<reason>")` |
**If you do not signal, the orchestrator will not know you are done and the session becomes orphaned.**

**Fallback:** If the `signal_completion` tool is not available, output your completion status as your final message in the format: `COMPLETION: status=<status> pr=<url>` or `COMPLETION: status=<status> error=<reason>`.
