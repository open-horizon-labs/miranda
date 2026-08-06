# Open Horizons Session Planning

Load this reference when `.oh/<session>.md` contains `## Problem Weave` or `### S&T Selection`.

## Selection Gate

- Read `### S&T Selection` from `## Solution Space`.
- Create implementation issues only for S&T step IDs marked `selected`.
- Preserve each selected step's parent objective, parent step, sufficiency group, owner, review trigger, necessity, and parallel assumption.
- Do not plan `candidate`, `rejected`, or `deferred` steps.
- Stop when a selected child depends on an unselected required parent or an incomplete sufficiency group. Report the planning gap instead of inventing work.

## Issue Hierarchy

- One independently deliverable selected tactic becomes one issue.
- Several selected tactics under one objective use a parent tracking issue, or an epic when the repository supports an epic issue type or label, plus child issues.
- A parent tracks the shared strategy or objective. Children enact selected tactics.
- Preserve dependencies with `Depends on #N`; hierarchy does not replace dependency links.
- Do not create an empty parent for one tactic.

Treat a selected tactic as the planning source, not automatically as one issue.
Split it only when the work has independently testable parts.
Keep every child attached to the selected step ID; do not create strategy branches during planning.

Before creating issues, verify that the selected child set satisfies its named sufficiency group.
If not, record the gap in the parent issue.
When execution disproves a parallel assumption, use the session's review trigger instead of rewriting the plan.

## Issue Lineage Block

Add this block to every issue derived from a selected S&T step:

```markdown
## S&T Lineage

- **Step:** <selected S&T step ID>
- **Parent objective:** <strategy from Problem Weave>
- **Parent step:** <root or parent step ID>
- **Sufficiency group:** <group ID and mode>
- **Necessity:** <why this tactic is required>
- **Parallel assumption:** <why this tactic is credible now>
- **Owner:** <role>
- **Review trigger:** <when to reassess>
```

## Session Plan Table

Update `## Plan` after creating issues:

```markdown
## Plan
**Updated:** <timestamp>

| S&T Step | Disposition | Issue/Epic | Parent Step | Depends On |
|---|---|---|---|---|
| [id] | selected | [#43] | [root/id] | [none/#N] |
```

## Workflow Handoff

```bash
# Ground the session
/aim auth-refactor
/problem-space auth-refactor
/problem-weave auth-refactor       # Optional for multi-layer problems
/problem-statement auth-refactor
/solution-space auth-refactor

# Plan selected work
/oh-plan auth-refactor

# Execute an issue
/oh-task 43
```
