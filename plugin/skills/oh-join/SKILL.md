---
name: oh-join
description: Resolve multi-dependency fan-in by merging dependency PRs into a common base and updating issue dependencies
---

# oh-join

Use this skill when an issue has 2+ open dependencies and scheduler cannot auto-stack because there is no single base branch.

## Invocation

`/oh-join <issue-number>`

- `<issue-number>`: target GitHub issue (for example `1178` or `#1178`)

## Goal

For target issue `#X`:
1. Read `Depends on:` dependencies
2. Find linked open PRs for those dependency issues
3. Verify dependency PRs are ready to merge
4. Merge them into one common base branch in deterministic order
5. Update target issue dependencies to reflect merged deps
6. Signal completion with outcome details

## Flow

1. **Load issue and dependencies**
   ```bash
   gh issue view <issue-number> --json number,title,body,state,url
   ```
   - Parse all dependency numbers from `Depends on:` lines.
   - If fewer than 2 dependencies: stop with `blocked` (not a join case).

2. **Discover open PRs for dependency issues**
   ```bash
   gh pr list --state open --json number,title,headRefName,baseRefName,body,url
   ```
   - Map dependency issue number -> linked PR by either:
     - branch pattern `issue/<N>` or `issue-<N>`
     - PR body containing `Closes #N` / `Fixes #N` / `Resolves #N`
   - If any dependency has no open PR: stop with `blocked` and list missing deps.

3. **Determine common base branch**
   - Collect `baseRefName` across dependency PRs.
   - If all same: that is the common base branch.
   - If different:
     - Attempt to find shared upstream branch by checking whether all base branches descend from a common candidate.
     - If no safe common base is found, stop with `blocked` and report conflicting bases.

4. **Readiness checks for each dependency PR**
   For each dep PR:
   ```bash
   gh pr checks <pr-number> --fail-on-error
   gh pr view <pr-number> --json reviewDecision,isDraft,mergeable
   ```
   - Must not be draft
   - Must be mergeable
   - CI checks must pass
   - Review decision must not be `CHANGES_REQUESTED`
   If any fail: stop with `blocked` and report specific PR reasons.

5. **Merge dependency PRs in deterministic order**
   - Sort by dependency issue number ascending.
   - For each PR in order:
     ```bash
     gh pr merge <pr-number> --squash
     ```
   - On failure:
     - Stop immediately
     - Report merged PRs vs failed PR
     - `signal_completion(status: "error", error: "...")`

6. **Update target issue dependencies**
   - Re-read target issue body.
   - Remove merged dependency issue numbers from `Depends on:` lines.
   - Keep still-open dependencies if any remain.
   - Append/update a machine section:
     ```md
     <!-- oh-join -->
     Joined deps: #A (PR #PA), #B (PR #PB)
     Base branch: <branch>
     Updated: <ISO timestamp>
     ```
   - Write back:
     ```bash
     gh issue edit <issue-number> --body-file <temp-file>
     ```

7. **Completion signaling**
   - Success:
     ```
     signal_completion(status: "success", message: "Merged dep PRs #... into <base>; updated issue #<issue-number> dependencies")
     ```
   - Blocked:
     ```
     signal_completion(status: "blocked", blocker: "<reason>")
     ```
   - Error:
     ```
     signal_completion(status: "error", error: "<reason>")
     ```

## Safety Rules

- Never merge PRs not linked to target dependencies.
- Never merge if CI is red/pending.
- Never continue after first merge failure.
- Never delete dependency context; only remove deps that are now merged.
- Always include exact issue/PR numbers in reports.

## Exit Conditions

- **Success**: all dependency PRs merged and issue dependencies updated
- **Blocked**: missing dep PR, ambiguous base, or failing readiness checks
- **Error**: merge/update operation failed unexpectedly

## Completion Signaling (MANDATORY)

You MUST call `signal_completion` as your final action.

If the tool is unavailable, end with one line:
- `COMPLETION: status=success message=<...>`
- `COMPLETION: status=blocked blocker=<...>`
- `COMPLETION: status=error error=<...>`
