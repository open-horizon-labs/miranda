# Portfolio State Model — Specification

**Date:** 2026-02-23
**Status:** Draft
**Scope:** Real-time, ambient-awareness state model for concurrent app factory builds

## 1. Purpose

Miranda's data is scattered across in-memory Maps, GitHub API responses, and scheduler state. No single object answers: "what is the complete state of everything I'm building right now?"

This spec defines a **Portfolio State Model** — a single, continuously-updated, JSON-serializable object that represents the full state of all concurrent factory builds. A visual surface subscribes to this model via SSE and renders it. The surface is a pure function of this state.

### Design Principles

1. **State, not events.** The model represents *what is*, not *what happened*. Consumers render current state, not replay event logs.
2. **Derived, not stored.** The model is computed from existing Miranda state (sessions, scheduler, GitHub data). It introduces no new primary storage.
3. **Complete at any instant.** A consumer connecting at any time receives the full portfolio state. No "you missed the beginning" problem.
4. **Attention as derived property.** Each element carries its own `attention` classification — not as a filter on an event stream, but as a computed property of its current state.
5. **Surface-agnostic.** The model defines what the surface needs, not how to render it. Multiple surfaces (web, Mini App, TUI) can subscribe.

## 2. Data Model

### 2.1 Root: `PortfolioState`

The top-level object. Published in full on SSE connect, then as diffs.

```typescript
interface PortfolioState {
  /** Schema version. Bump on breaking changes. */
  version: 1;

  /** ISO-8601 timestamp of when this snapshot was computed. */
  timestamp: string;

  /** Portfolio-level pulse — a single-glance health indicator. */
  pulse: Pulse;

  /** Capacity: agent slots. */
  capacity: Capacity;

  /** Per-factory-app state, keyed by app name (from factory:<app>:<phase> labels). */
  apps: Record<string, AppState>;

  /** Active agent sessions not tied to a factory app (oh-plan, oh-merge, etc). */
  auxSessions: AgentState[];

  /** Items requiring human attention, ranked by urgency. */
  attention: AttentionItem[];
}
```

### 2.2 Pulse

Portfolio-level health derived from the aggregate state of all apps and agents. The surface uses this for the ambient "glance" — one signal for the whole portfolio.

```typescript
type Pulse = "calm" | "busy" | "waiting" | "alert";
```

| Value | Meaning | Derivation |
|---|---|---|
| `calm` | Everything progressing normally. No attention items. | All agents running or done. No pending attention items. |
| `busy` | Agents are working. Nothing wrong. | At least one agent active, no attention items. |
| `waiting` | At least one thing needs the builder's input. | One or more `attention` items exist, none are errors. |
| `alert` | Something is broken or stale. | At least one attention item has `urgency: "high"`. |

Derivation rule (in priority order — first match wins):
1. Any attention item with `urgency: "high"` → `alert`
2. Any attention items → `waiting`
3. Any agents with `status: "working"` → `busy`
4. Otherwise → `calm`

### 2.3 Capacity

```typescript
interface Capacity {
  /** Max concurrent oh-task sessions (from config.schedulerMaxConcurrent). */
  total: number;

  /** Currently active oh-task sessions (starting | running | waiting_input). */
  used: number;

  /** Issues queued for scheduling but slot-blocked. */
  queued: number;
}
```

Source: `config.schedulerMaxConcurrent`, `getAllSessions()`, scheduler's `scheduledChains`.

### 2.4 AppState

Per-factory-app state. One entry per unique app name parsed from `factory:<app>:<phase>` labels.

```typescript
interface AppState {
  /** App name (e.g., "dm", "crm"). */
  name: string;

  /** Project this app belongs to (Miranda project name). */
  project: string;

  /** GitHub owner/repo. */
  repo: string;

  /** Current pipeline phase — the earliest phase with open issues. */
  currentPhase: FactoryPhase;

  /** Per-phase breakdown. */
  phases: PhaseState[];

  /** Overall app health — derived from phase states + agent states. */
  health: AppHealth;

  /** Timestamp of last meaningful state change (agent start/stop, PR merge, phase advance). */
  lastActivity: string;
}

type FactoryPhase = "build" | "audit" | "critique" | "done";

type AppHealth =
  | "progressing"     // Agents working, no blockers
  | "waiting"         // Agent asked a question or PR needs review
  | "blocked"         // Dependency cycle, CI failure, or agent error
  | "stalled"         // No activity for > threshold (e.g., 10 minutes with no tool calls)
  | "done";           // All phases complete (no open issues with factory labels)
```

Health derivation (first match wins):
1. Any phase has an agent with `status: "error"` → `blocked`
2. Any phase has an agent with `status: "asking"` or a PR with failing CI → `waiting`
3. No open issues across all phases → `done`
4. No agent activity for > `STALE_THRESHOLD_MS` → `stalled`
5. Otherwise → `progressing`

### 2.5 PhaseState

```typescript
interface PhaseState {
  /** Phase name. */
  phase: FactoryPhase;

  /** Phase status relative to the pipeline. */
  status: "done" | "active" | "pending";

  /** Issue counts for this phase. */
  issues: {
    total: number;
    open: number;
    closed: number;
  };

  /** Issues in this phase with their individual state. */
  issueDetails: IssueState[];
}
```

Phase `status` derivation:
- `done`: no open issues in this phase (all closed/merged)
- `active`: has open issues AND is the earliest phase with open issues (or has an active agent)
- `pending`: has open issues but an earlier phase is still active

### 2.6 IssueState

Per-issue state within a factory phase.

```typescript
interface IssueState {
  /** GitHub issue number. */
  number: number;

  /** Issue title. */
  title: string;

  /** Which factory phase this issue belongs to. */
  phase: FactoryPhase;

  /** Issue-level status. */
  status: IssueStatus;

  /** Dependencies (issue numbers this depends on). */
  dependsOn: number[];

  /** Whether all dependencies are resolved. */
  depsResolved: boolean;

  /** Linked PR, if any. */
  pr: PRState | null;

  /** Active agent session, if any. */
  agent: AgentState | null;
}

type IssueStatus =
  | "queued"          // Open, deps not resolved, no agent
  | "ready"           // Open, deps resolved, no agent yet
  | "in_progress"     // Agent is working on it
  | "in_review"       // PR exists, agent done, awaiting CI/review
  | "done";           // Issue closed (PR merged)
```

Status derivation:
1. Issue closed → `done`
2. Has PR, no active agent → `in_review`
3. Has active agent session → `in_progress`
4. All deps resolved → `ready`
5. Otherwise → `queued`

### 2.7 PRState

```typescript
interface PRState {
  /** PR number. */
  number: number;

  /** Branch name (head ref). */
  branch: string;

  /** PR URL for drill-down. */
  url: string;

  /** CI status. */
  ci: CIHealth;

  /** Code review status. */
  review: ReviewHealth;

  /** Whether the branch is behind base and needs update. */
  behindBase: boolean;

  /** Whether there are merge conflicts. */
  hasConflicts: boolean;
}

type CIHealth = "passing" | "failing" | "pending" | "none";
type ReviewHealth = "approved" | "changes_requested" | "pending" | "none";
```

Mapped from Miranda's existing `PREnrichment`:
- `ci` maps from `CIStatus.state`: `"success"` → `"passing"`, `"failure"` → `"failing"`, etc.
- `review` maps from `CodeRabbitStatus.state`: `"APPROVED"` → `"approved"`, etc.
- `behindBase` maps from `mergeStateStatus === "BEHIND"`
- `hasConflicts` maps from `mergeable === false`

### 2.8 AgentState

Per-agent session state. Represents what a single oh-my-pi agent is doing right now.

```typescript
interface AgentState {
  /** Miranda session key (e.g., "oh-task-myapp-42"). */
  sessionKey: string;

  /** Skill type. */
  skill: SkillType;

  /** Which app/issue this agent is working on (null for non-factory sessions). */
  app: string | null;
  issueNumber: number | null;

  /** Agent lifecycle status. */
  status: AgentStatus;

  /** What the agent is doing right now — last tool call or text output. */
  currentActivity: string | null;

  /** The tool currently being executed, if any. */
  currentTool: string | null;

  /** When this session started. */
  startedAt: string;

  /** How long the session has been running (seconds). */
  elapsed: number;

  /** If status is "asking", the pending question. */
  question: PendingQuestionState | null;

  /** If status is "blocked" or "error", the reason. */
  reason: string | null;

  /** If the agent signaled completion with a PR. */
  resultPR: string | null;
}

type AgentStatus =
  | "starting"      // Process spawned, not yet running
  | "working"       // Actively executing (tool calls happening)
  | "thinking"      // Text generation (no tool calls recently)
  | "asking"        // Waiting for human input (extension_ui_request)
  | "done"          // Signaled completion successfully
  | "error"         // Signaled error or crashed
  | "blocked";      // Signaled blocked (needs human decision)
```

Note: `"working"` vs `"thinking"` is derived from recent log events:
- If the last SSE event was `tool_start` or `tool_end` within the last 5 seconds → `working`
- If the last SSE event was `text` → `thinking`
- If `session.status === "waiting_input"` → `asking`
- If agent signaled with `status: "error"` → `error`
- If agent signaled with `status: "blocked"` → `blocked`
- If agent signaled with `status: "success"` → `done`

### 2.9 PendingQuestionState

When an agent is in `asking` status, this carries the question context.

```typescript
interface PendingQuestionState {
  /** The question text. */
  text: string;

  /** Header/title of the question. */
  header: string;

  /** Available options (empty for free-text input). */
  options: string[];

  /** UI method type. */
  method: "select" | "confirm" | "input";

  /** How long the question has been waiting (seconds). */
  waitingSince: string;

  /** Duration waiting (seconds). Stale questions surface as attention items. */
  waitingSeconds: number;
}
```

### 2.10 AttentionItem

The most important type. This is what the surface renders prominently. Each item represents something that needs the builder's judgment.

```typescript
interface AttentionItem {
  /** Unique ID for this attention item (for dedup and dismissal). */
  id: string;

  /** What kind of attention is needed. */
  type: AttentionType;

  /** How urgent. Determines visual treatment. */
  urgency: "high" | "medium" | "low";

  /** Which app this relates to (null for cross-app items). */
  app: string | null;

  /** Which issue (if applicable). */
  issueNumber: number | null;

  /** Which PR (if applicable). */
  prNumber: number | null;

  /** Human-readable one-line summary. */
  summary: string;

  /** Pre-assembled context for the decision. */
  context: AttentionContext;

  /** When this item was first detected. */
  since: string;

  /** How long this has been waiting (seconds). */
  waitingSeconds: number;

  /** Available actions the builder can take from the surface. */
  actions: AttentionAction[];
}

type AttentionType =
  | "question"         // Agent asked a question (waiting_input)
  | "agent_error"      // Agent signaled error
  | "agent_blocked"    // Agent signaled blocked
  | "ci_failure"       // PR CI is red
  | "review_requested" // PR has changes_requested from CodeRabbit
  | "merge_conflict"   // PR has conflicts
  | "cycle_detected"   // Dependency cycle in scheduler
  | "stale_session"    // Agent hasn't done anything for too long
  | "pr_ready"         // PR is green + approved, ready to merge
  ;

interface AttentionContext {
  /** Issue title for quick reference. */
  issueTitle: string | null;

  /** Current factory phase. */
  phase: FactoryPhase | null;

  /** The question being asked (for type "question"). */
  question: PendingQuestionState | null;

  /** Error message (for type "agent_error"). */
  error: string | null;

  /** Blocker description (for type "agent_blocked"). */
  blocker: string | null;

  /** PR URL for drill-down. */
  prUrl: string | null;

  /** Issue URL for drill-down. */
  issueUrl: string | null;
}

interface AttentionAction {
  /** Action identifier (used by the surface to call back). */
  id: string;

  /** Human-readable label. */
  label: string;

  /** Visual treatment hint. */
  style: "primary" | "secondary" | "danger";
}
```

#### Attention Derivation Rules

| Source Condition | AttentionType | Urgency | Actions |
|---|---|---|---|
| Session `status: "waiting_input"`, question pending | `question` | `high` if waiting > 5min, else `medium` | Answer options (from question), "View logs" |
| Agent `signal_completion: error` | `agent_error` | `high` | "View logs", "Restart", "Skip" |
| Agent `signal_completion: blocked` | `agent_blocked` | `high` | "View logs", "Unblock" (sends message to agent) |
| PR `ci: "failing"` | `ci_failure` | `medium` | "View PR", "View logs", "Restart agent" |
| PR `review: "changes_requested"` | `review_requested` | `medium` | "View PR", "Start oh-notes" |
| PR `hasConflicts: true` | `merge_conflict` | `medium` | "Update branch", "View PR" |
| Scheduler detects cycle | `cycle_detected` | `high` | "View issues" |
| Agent running but no tool calls for > `STALE_THRESHOLD_MS` | `stale_session` | `low` (escalates to `medium` after 2x threshold) | "View logs", "Stop agent" |
| PR `ci: "passing"` AND `review: "approved"` AND `!behindBase` | `pr_ready` | — | Not an attention item. See §9 Q1. Surface renders as badge/count. |

#### Urgency Escalation

Attention items that go unaddressed escalate:
- `low` → `medium` after 10 minutes
- `medium` → `high` after 30 minutes
- `high` stays `high` (cannot escalate further)

The `since` timestamp enables this: `urgency` is recomputed on each state snapshot.

## 3. SSE Protocol

### 3.1 Endpoint

```
GET /api/portfolio/stream
```

Authentication: Same as existing Miranda API (Telegram initData).

### 3.2 Wire Format

Full `PortfolioState` snapshot on every publish. No JSON Patch.

```
event: state
data: { "version": 1, "_rev": 42, "timestamp": "...", "pulse": "busy", ... }
```

Sent on:
- **Connect:** Immediate full snapshot.
- **State change:** Debounced (500ms). Multiple rapid mutations collapse into one publish.
- **High-priority change:** Immediate (bypasses debounce). Triggered by: `waiting_input`, `signal_completion`, agent crash.
- **Tick:** Every 5 seconds for time-based fields (`elapsed`, `waitingSeconds`, urgency escalation, stale detection).
- **Heartbeat:** `event: heartbeat` with `{ "timestamp": "..." }` every 15 seconds if no state events.

### 3.3 Reconnection

On reconnect, the server sends a fresh full snapshot. The model is state, not events — the current snapshot is always complete. No replay, no catch-up.

## 4. Computation

### 4.1 State Sources

The portfolio state is derived from these existing Miranda data sources:

| Data | Source | Access |
|---|---|---|
| Active sessions | `getAllSessions()` | `state/sessions.ts` — in-memory Map |
| Session questions | `session.pendingQuestion` | `types.ts` — on Session object |
| Agent processes | `getAllAgents()` | `agent/process.ts` — in-memory Map |
| Agent last activity | `session.lastToolActivityAt` | `types.ts` — on Session object (§9 Q4) |
| Scheduler state | `getSchedulerStatus()`, `projectStates` | `scheduler/watcher.ts` |
| Open issues | `getOpenIssues()` | `api/github.ts` — GitHub API (cached) |
| Open PRs + enrichment | `getOpenPRs()`, `getPREnrichment()` | `api/github.ts` — GitHub API (cached) |
| Dependency graph | `buildDependencyGraph()` | `scheduler/graph.ts` |
| Factory phases | `parseFactoryLabel()` | `scheduler/graph.ts` |
| Projects | `scanProjects()` | `projects/scanner.ts` |

### 4.2 Computation Cycle

The portfolio state is recomputed:

1. **On internal state change:** Session created/updated/deleted, agent event received, scheduler poll completes. These are the "fast" triggers — recompute from in-memory state only.

2. **On GitHub data refresh:** Scheduler polls GitHub every 60s. When new issue/PR data arrives, recompute the GitHub-dependent parts (issue statuses, PR states, enrichment). This is the "slow" trigger.

3. **On timer:** Every 5 seconds, recompute derived time-based fields (`elapsed`, `waitingSeconds`, urgency escalation, stale detection). This keeps the surface live even when nothing changes.

The recomputation is cheap because all source data is already in memory or in short-TTL caches. The portfolio module does not make additional API calls — it reads what Miranda already knows.

### 4.3 Module Structure

```
miranda/src/portfolio/
├── state.ts          // PortfolioState computation from Miranda internals
├── attention.ts      // AttentionItem derivation rules
├── stream.ts         // SSE endpoint, diff computation, subscriber management
├── types.ts          // All types from this spec (exported for surface consumption)
└── index.ts          // Public API: init(), getSnapshot(), subscribe()
```

### 4.4 Hooking Into Miranda

The portfolio module hooks into Miranda's existing event flow:

```
handleAgentEvent() ──→ existing SSE fan-out (logs.ts)
                   ──→ NEW: portfolio.onAgentEvent(sessionId, event)

scheduler.pollProject() ──→ existing scheduling logic
                         ──→ NEW: portfolio.onSchedulerUpdate(projectName, result)

sessions.setSession() ──→ existing session update
                       ──→ NEW: portfolio.onSessionChange(taskId, session)
```

These hooks call `portfolio.recompute()` which diffs and publishes to SSE subscribers.

## 5. Attention Item Lifecycle

Attention items are not stored — they're derived on each computation cycle. An item exists in the `attention` array if and only if its derivation condition is true in the current state.

This means:
- When a builder answers a question → session moves out of `waiting_input` → attention item disappears on next recompute.
- When CI turns green → `ci_failure` attention item disappears.
- When a stale agent starts doing something → `stale_session` disappears.

No explicit "dismiss" needed for most items. The state change IS the dismissal.

Exception: `pr_ready` (PR ready to merge) is `low` urgency and informational. The builder might want to batch merges. The surface could allow explicit "I'll merge later" dismissal, but this is a surface concern, not a state model concern.

## 6. Constants

```typescript
/** Seconds of no tool_start/tool_end events before an agent is "stale". */
const STALE_THRESHOLD_S = 600;  // 10 minutes

/** Seconds before a low-urgency item escalates to medium. */
const ESCALATE_LOW_TO_MEDIUM_S = 600;  // 10 minutes

/** Seconds before a medium-urgency item escalates to high. */
const ESCALATE_MEDIUM_TO_HIGH_S = 1800;  // 30 minutes

/** Recomputation interval for time-based fields. */
const TICK_INTERVAL_MS = 5000;  // 5 seconds

/** SSE heartbeat interval. */
const HEARTBEAT_INTERVAL_MS = 15000;  // 15 seconds
```

## 7. Invariants

These must always hold:

1. **Snapshot completeness.** A freshly-connected subscriber receives a full `PortfolioState` that is renderable without any prior context.

2. **Attention derivation.** Every `AttentionItem` in the array must be derivable from the current state. No stale items. No phantom alerts.

3. **Pulse consistency.** `pulse` must agree with the `attention` array. If `attention` is empty, `pulse` cannot be `"waiting"` or `"alert"`.

4. **App completeness.** Every factory-labeled issue across all enabled projects must appear in exactly one `AppState.phases[].issueDetails[]` entry.

5. **Agent uniqueness.** Each Miranda session appears as an `AgentState` in exactly one place: either inside an `IssueState.agent` (for factory-bound sessions) or in `auxSessions` (for non-factory sessions like oh-plan, oh-merge).

6. **No data fetching.** The portfolio module never calls GitHub API directly. It reads from Miranda's existing caches and in-memory state. If the cache is stale, the portfolio renders stale data. The scheduler's poll cycle is the refresh mechanism.

7. **Idempotent recompute.** Calling `recompute()` twice with no intervening state change produces identical snapshots. No side effects.

## 8. Out of Scope

- **Decision logging.** The state model doesn't record what the builder decided or when. That's a future concern (and a good one — pairs well with Memex).
- **Historical state.** No time-series. The model is a point-in-time snapshot. History could be added by persisting snapshots, but that's a separate concern.
- **Multi-project portfolio.** The model supports multiple projects (via `AppState.project`), but the initial implementation can focus on one project if that's simpler.
- **Agent conversation summaries.** `currentActivity` is the last tool call intent string, not a conversation summary. Summarization is expensive and out of scope for v1.
- **Notification routing.** The state model doesn't decide how to notify. It exposes state. The surface decides what to show and how.

## 9. Resolved Design Decisions

### Q1: `pr_ready` — attention item or visual state?

**Decision:** Visual state on the PR, not an attention item. `pr_ready` is informational — the builder decides when to batch-merge. The `PRState` already carries `ci` and `review` fields; the surface can render a "ready to merge" indicator directly. Putting it in the attention queue dilutes the queue's meaning ("things that need judgment"). A badge/count on the portfolio surface ("3 PRs ready to merge") is better.

Add to `PortfolioState`:

```typescript
interface PortfolioState {
  // ... existing fields ...

  /** Counts of PRs in each state, for badge rendering. */
  prSummary: {
    readyToMerge: number;
    ciPassing: number;
    ciFailing: number;
    reviewPending: number;
  };
}
```

### Q2: Attention actions — executable or links?

**Decision:** Links to existing Miranda API endpoints. The portfolio endpoint exposes state; the surface calls Miranda's existing REST API to act. The `AttentionAction.id` encodes the API call:

```typescript
// Example actions for a "question" attention item:
actions: [
  {
    id: "answer",
    label: "Answer",
    style: "primary",
    // Surface knows: POST /api/sessions/:id/respond
    // with the selected option from the question context
  },
  {
    id: "view_logs",
    label: "View Logs",
    style: "secondary",
    // Surface knows: open SSE stream at /api/sessions/:id/logs
  }
]
```

The surface maintains a mapping from `action.id` to API endpoint + parameters. The state model doesn't need to carry URLs.

### Q3: JSON Patch vs. full snapshot?

**Decision:** Full snapshots for v1. The state is small (< 10KB for 3 concurrent builds, ~20 issues). Full snapshots eliminate:
- Client-side patch application logic
- Patch ordering/consistency bugs
- Need for server to track per-subscriber last-sent state

The SSE protocol simplifies to:

```
event: state
data: { full PortfolioState JSON }
```

Sent on: connect (immediate), state change (debounced 500ms), tick (every 5s for time-based fields).

If the portfolio grows beyond ~50KB, revisit with JSON Patch (RFC 6902). The type definitions don't change — only the wire protocol.

### Q4: Stale session detection — log ring buffer or timestamp?

**Decision:** Add `lastToolActivityAt: Date` to the `Session` type. Updated in `handleAgentEvent` when `tool_execution_start` or `tool_execution_end` events arrive. The portfolio module reads this timestamp directly — no coupling to `logs.ts` internals.

Required change to Miranda's `Session` interface:

```typescript
interface Session {
  // ... existing fields ...

  /** Updated on each tool_execution_start/end event. Used for stale detection. */
  lastToolActivityAt?: Date;
}
```

Updated in `handleAgentEvent()` in `events.ts`:

```typescript
case "tool_execution_start":
case "tool_execution_end": {
  const session = findSessionBySessionId(sessionId);
  if (session) {
    session.lastToolActivityAt = new Date();
    setSession(session.taskId, session);
  }
  // ... existing handling ...
}
```

## 10. Cross-Cutting Concerns

### 10.1 Attention Queue Ordering

The `attention` array is ordered by priority. Within the same urgency tier, items are ranked by `waitingSeconds` (oldest first). This ensures the builder sees the most urgent and most stale items at the top.

Sort key: `(urgency_rank, -waitingSeconds)` where `urgency_rank`: high=0, medium=1, low=2.

### 10.2 Unexpected Agent Exit

When an agent process exits unexpectedly (`handleAgentExit` with `session.status` still `running`), this should surface as an attention item. The current spec covers `agent_error` (from `signal_completion: error`) but not crashes.

Add derivation rule:

| Source Condition | AttentionType | Urgency | Actions |
|---|---|---|---|
| Agent process exited unexpectedly (no `signal_completion`) | `agent_crashed` | `high` | "View logs", "Restart" |

This requires the portfolio module to observe session deletion events. When a session is deleted with `session.signaled === false`, it's a crash.

Add `agent_crashed` to the `AttentionType` union:

```typescript
type AttentionType =
  | "question"
  | "agent_error"
  | "agent_blocked"
  | "agent_crashed"      // Process exited without signaling completion
  | "ci_failure"
  | "review_requested"
  | "merge_conflict"
  | "cycle_detected"
  | "stale_session"
  ;
```

### 10.3 Auxiliary Session Attention

`auxSessions` (oh-plan, oh-merge, oh-review, oh-notes) also need attention routing. The same rules apply: `waiting_input` → attention item, `signal_completion: error` → attention item, etc. The only difference is `app` is null on these items (or derived from the project name).

### 10.4 Session Outcome Retention

When a session completes and is deleted from Miranda's in-memory Map, the portfolio state loses it instantly. For the surface, this creates a jarring experience — an agent that was visible disappears without trace.

**Decision:** The portfolio module maintains a short-lived `recentOutcomes` buffer (last 10 completed sessions, kept for 5 minutes). This allows the surface to animate the transition (agent finishes → shows completion state briefly → fades out).

```typescript
interface PortfolioState {
  // ... existing fields ...

  /** Recently completed sessions (kept for 5 min for transition animation). */
  recentOutcomes: SessionOutcome[];
}

interface SessionOutcome {
  sessionKey: string;
  skill: SkillType;
  app: string | null;
  issueNumber: number | null;
  result: "success" | "error" | "blocked" | "crashed";
  prUrl: string | null;
  error: string | null;
  completedAt: string;
}
```

### 10.5 Debounce Strategy

Agent events arrive at high frequency (multiple tool calls per second during active work). Recomputing and publishing the full portfolio state on every event would be wasteful.

**Strategy:**
- **Internal state mutation:** Immediate. Update `lastToolActivityAt`, session status, etc. as events arrive.
- **Snapshot publication:** Debounced. After any mutation, schedule a snapshot publish with a 500ms debounce. Multiple rapid mutations collapse into one publish.
- **Time-based tick:** Every 5 seconds regardless, for `elapsed`, `waitingSeconds`, urgency escalation, stale detection.
- **Forced publish on high-priority change:** Session enters `waiting_input`, `signal_completion` received, or agent crashes → publish immediately (bypass debounce). These are the attention-routing moments.

### 10.6 Surface Hint: State Transitions

Since we send full snapshots (not diffs), the surface must diff locally to detect transitions. To make this easier, each state object carries a `_rev` field — a monotonically increasing integer that changes whenever the object's state changes meaningfully. The surface can cheaply compare `_rev` values to detect which objects changed.

```typescript
interface PortfolioState {
  // ... existing fields ...

  /** Monotonic revision counter. Incremented on each publish. */
  _rev: number;
}

interface AppState {
  // ... existing fields ...

  /** App-level revision. Incremented when any child state changes. */
  _rev: number;
}
```

This is a surface hint, not a correctness requirement. The surface MAY ignore it and diff the full state.

## 11. Implementation Sequence

### Phase 1: Types + Session Extension
1. Add `lastToolActivityAt` to `Session` interface in `types.ts`
2. Update `handleAgentEvent` in `events.ts` to set `lastToolActivityAt` on tool events
3. Create `src/portfolio/types.ts` with all types from this spec
4. Create `src/portfolio/attention.ts` with derivation rules (pure functions, no side effects)

### Phase 2: State Computation
5. Create `src/portfolio/state.ts` — `computeSnapshot()` function that reads all Miranda state sources and returns a `PortfolioState`
6. Write tests: given known session/scheduler/GitHub state, verify snapshot correctness
7. Verify invariants (snapshot completeness, attention derivation, pulse consistency)

### Phase 3: Integration + SSE
8. Create `src/portfolio/stream.ts` — SSE endpoint, subscriber management, debounce
9. Hook into Miranda event flow (agent events, scheduler updates, session changes)
10. Create `src/portfolio/index.ts` — init, lifecycle management
11. Wire into Miranda's HTTP server (`routes.ts`): `/api/portfolio/stream`

### Phase 4: Validation
12. Run with live factory builds, verify state correctness against manual observation
13. Tune constants (stale threshold, debounce interval, escalation timers)
14. Profile: recomputation cost at 3 concurrent sessions, 20 issues

## 12. Architecture — Engine and World

Miranda is the engine. Everything from §12 onward is the world built on that engine.

### 12.1 The Engine

Miranda provides:

| Capability | Mechanism | Contract |
|---|---|---|
| **Spawn agent** | `spawnAgent()` + `sendPrompt(agent, string)` | Takes a prompt string. Returns a session. Doesn't parse, interpret, or validate the prompt. |
| **Kill agent** | `killAgent(agent)` | Terminates the process. |
| **Answer agent** | `sendUIResponse(agent, response)` | Replies to a pending `extension_ui_request`. |
| **Track sessions** | In-memory `Map<string, Session>` | Session lifecycle: starting → running → waiting_input → stopped. |
| **Poll GitHub** | Scheduler watcher + GitHub API client | Fetches issues, PRs, CI status, reviews. Labels, dep graph, enrichment. |
| **Schedule work** | Dep graph + concurrency limiter | Respects `dependsOn`, `factory:<app>:<phase>` ordering, max concurrent slots. |
| **Stream events** | RPC events from agent stdout → `handleAgentEvent()` | Tool calls, completions, questions, errors. Fan-out to SSE log subscribers. |
| **Serve HTTP** | Express routes | REST endpoints for sessions, projects, PRs, logs, health. |

The engine doesn't know what a "skill" is in any meaningful sense. `SkillType` is a label on a session for routing Telegram notifications. The engine's actual contract is: **you give me a prompt string and a working directory, I run it in an oh-my-pi process and track the session.**

### 12.2 The World

The world is everything that gives meaning to the engine's capabilities:

- **Overmind** (§12.3): A partner LLM that is the brain of the world. Raw state goes in, judgment comes out. Replaces fragile parsing and convoluted conditionals with comprehension.
- **Portfolio State Model** (§2–§10): The game state — the minimap, the production tab, the resource counter. Mechanical parts are computed directly; semantic parts are produced by the Overmind.
- **Prompt Factory** (§13): Composes prompts from factory context + situation + builder guidance. The LLM writes the prompts; the engine runs them.
- **Pre-built Skills**: Unit types. `oh-task`, `oh-ci`, `oh-conflict`, `oh-review` — reusable prompt templates. First-class, battle-tested, always available. The Overmind enriches them with context.
- **Factory Context** (§14): The app-factory's output as ground truth. The Overmind reads it; brittle parsing code doesn't.
- **Evaluation Pipeline** (§14.5): Alignment checks on completed work. Powered by the Overmind, not by diff-parsing heuristics.
- **Surface** (§16): The screen. Renders state, accepts commands. Pure function of world state.

### 12.3 The Overmind

The world layer needs to do things that are fundamentally about comprehension, not computation:

| Task | Without LLM (brittle) | With LLM (robust) |
|---|---|---|
| Parse factory spec from issue body | Regex for tool tables, heading parsers, markdown structure assumptions. Breaks when format varies. | "Read this issue body. Extract: aim, tools, cards, design tone, acceptance criteria." |
| Derive attention items | `if (ci === 'failing') attention.push(...)`. Handles known cases. Silent on novel failures. | "Given this portfolio state, what needs the builder's attention? Why? How urgent?" |
| Compose a situation-specific prompt | String concatenation with template slots. Generic, context-blind. | "Given this factory spec, this issue, and this situation, write a prompt for an agent that will fix it." |
| Summarize a deviation for the attention strip | `pr.approach !== issue.approach` — but how do you compare "approaches" as strings? | "Compare PR #87's diff against issue #42's spec. Summarize the deviation in one line." |
| Decide automation level | Hardcoded rules. CI fail → always auto-fix. No nuance. | "This CI failure is in a test that validates the factory spec's tool registration pattern. The test might be right and the code wrong. Flag for builder." |
| Evaluate alignment | Keyword matching on PR diff vs issue body. Laughably fragile. | "Does this PR implement what the issue specified? In the way the factory intended?" |

Every one of these is an LLM's native capability. Every one of these, built as code, would be a brittle mess of heuristics and edge cases that breaks on the first unusual factory spec.

But a naive Overmind — dump state into a single structured-output call, hope for good JSON — is **worse than no Overmind**. It would hallucinate attention items (false positives erode trust), miss context it can't see (PR diffs don't fit in one prompt), produce inconsistent summaries, have no memory of past evaluations, and create false confidence in a surface that lies to you.

The Overmind must be a real agent. Not a function call. A persistent, infinite agentic loop — always alive, always watching, always accumulating understanding.

#### The Overmind is a Persistent Agentic Loop

The Overmind is a long-running process built on `memex-core` building blocks. It subscribes to Miranda's event stream, maintains conversational continuity across reasoning cycles, accumulates memory in LanceDB, and uses tools to inspect the things it needs to understand. It never terminates. It is the cerebrate.

```
┌─────────────────────────────────────────────────────────────┐
│                       OVERMIND (daemon)                     │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ SSE Listener │  │ Agentic Loop │  │  LanceDB Memory   │  │
│  │ (sensory     │─▶│ (LLM + tools │─▶│  (factory specs,  │  │
│  │  input)      │  │  multi-step  │  │   evaluations,    │  │
│  │              │  │  reasoning)  │  │   builder prefs,  │  │
│  │              │  │              │  │   drift patterns)  │  │
│  └──────────────┘  └──────┬───────┘  └───────────────────┘  │
│                           │                                  │
│  ┌─────────────────┐     │     ┌────────────────────────┐   │
│  │ Significance     │     │     │  Judgment Emitter      │   │
│  │ Gate (filters    │     │     │  (attention, evals,    │   │
│  │  noise, batches  │     │     │   automation, prompts) │   │
│  │  real changes)   │     │     │                        │   │
│  └─────────────────┘     │     └───────────┬────────────┘   │
│                           │                 │                │
├───────────────────────────┼─────────────────┼────────────────┤
│                           │                 │                │
│                     ENGINE (Miranda)        │                │
│                                             ▼                │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────────────┐    │
│  │ Sessions │  │Scheduler │  │  Portfolio State Model  │    │
│  │ + Agents │  │+ Dep Grph│  │  (mechanical + semantic) │    │
│  └─────────┘  └──────────┘  └────────────┬────────────┘    │
│                                           │                 │
│  ┌─────────┐  ┌──────────┐  ┌────────────▼────────────┐    │
│  │  HTTP   │  │  Events  │  │  Surface (renderer)     │    │
│  │  API    │  │  Fan-out │  │                         │    │
│  └─────────┘  └──────────┘  └─────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### The Loop

The Overmind runs an infinite loop. Not request/response. Not cron. A daemon with a heartbeat of its own:

```
connect(miranda_sse)
loop {
    events ← wait_for_significant_batch()     // gate: skip noise, batch real changes
    context ← assemble(events, memory, specs)  // what happened, what I know, what matters

    // Agentic reasoning cycle — multi-step, tool-assisted.
    // The LLM can read a PR diff, then read the factory spec,
    // then search past evaluations for similar drift patterns,
    // then conclude. Not single-shot. Not hope-for-good-JSON.
    judgments ← reason(context, tools)

    emit(judgments)                             // → portfolio state model → surface
    persist(judgments)                          // → LanceDB: builds memory over time

    // Conversation continues. The LLM remembers what it evaluated,
    // what the builder corrected, what patterns it has seen.
    // Periodic consolidation compresses history into wisdom.
}
```

The loop never exits. When Miranda restarts, the Overmind reconnects and resumes. Its LanceDB memory survives restarts. Its conversational context is rebuilt from persisted state + recent memory.

#### Significance Gate

Not every SSE tick triggers reasoning. The Overmind gates on significance — borrowing from `sammy-mind`'s gating pattern (embedding similarity, skip-lists for infrastructure noise).

**Always significant** (trigger reasoning cycle):
- Agent completion (success or failure)
- CI status change on a factory PR
- New issue with factory label appears
- Agent enters `asking` state (needs human input)
- PR merge conflict detected
- Agent idle for >10 minutes (possible stall)

**Never significant** (pure noise, skip):
- Heartbeat ticks (tool activity timestamps)
- Agent status flip between `working` ↔ `thinking` (normal rhythm)
- GitHub polling refresh with no state change

**Batched** (accumulate, process together):
- Multiple CI checks completing on the same PR
- Multiple issues becoming ready in the same scheduler cycle
- Rapid agent status changes during startup

The gate produces a `SignificantBatch` — a structured summary of what changed since the last reasoning cycle. This is the Overmind's sensory input.

#### Tools

The Overmind has tools. It doesn't guess from a state dump — it inspects what it needs:

| Tool | Category | Purpose |
|---|---|---|
| `read_issue(number)` | Pure | Read full issue body, labels, state |
| `read_pr_diff(number)` | Pure | Read PR diff (summary or full) |
| `read_factory_spec(app)` | Pure | Retrieve cached factory context for an app |
| `get_portfolio_snapshot()` | Pure | Current mechanical state |
| `search_evaluations(query)` | Pure | Semantic search over past evaluation results |
| `search_builder_corrections(query)` | Pure | Find times the builder overrode/redirected |
| `emit_attention(item)` | Effect | Publish an attention item to the portfolio state |
| `emit_evaluation(verdict)` | Effect | Publish an alignment evaluation result |
| `emit_automation_decision(decision)` | Effect | Publish an automation decision (auto/flag) |
| `compose_prompt(spec)` | Effect | Compose a situation-specific agent prompt |
| `request_spawn(prompt, cwd)` | Effect | Ask Miranda to spawn an agent session |

Pure tools gather information. Effect tools emit judgments and trigger actions. The agentic loop (from `memex-core`) handles tool dispatch, retry, and iteration limits per reasoning cycle.

#### Memory

The Overmind accumulates understanding in LanceDB (borrowing `sammy-mind`'s storage pattern):

| Table | Contents | Embedding? |
|---|---|---|
| `factory_contexts` | Per-app factory specs: aim, domain map, tools, design tone, acceptance criteria. Parsed on first encounter, updated when factory issue body changes. | Yes — enables "find apps with similar architecture" |
| `evaluations` | Every alignment evaluation: issue, PR, verdict, deviations, confidence, timestamp. | Yes — enables "has this drift happened before?" |
| `builder_corrections` | Every time the builder overrides, redirects, or answers a question. | Yes — enables "the builder prefers X over Y" |
| `attention_log` | What was flagged, what was acted on, what was dismissed. | No — enables false-positive learning |
| `wisdom` | Consolidated insights distilled from accumulated experience. | Yes — compressed long-term memory |

This memory is what separates the Overmind from a naive LLM call. After evaluating 50 PRs, it *knows* that agent oh-task tends to use REST patterns where the factory spec calls for MCP. It *knows* the builder always redirects on that. It flags it preemptively.

#### Consolidation

The LLM conversation can't grow forever. Periodically (every N reasoning cycles, or when context window pressure exceeds a threshold), the Overmind consolidates:

1. **Distill wisdom** — extract reusable patterns from recent evaluations and decisions into the `wisdom` table. "Agent oh-task drifts on tool registration patterns when the factory spec uses non-standard naming."
2. **Compress conversation** — summarize the conversation history, discard raw tool results, keep conclusions. The LLM receives the compressed summary + recent raw events on the next cycle.
3. **Prune attention log** — archive resolved attention items, compute false-positive rate, adjust confidence thresholds.

This is directly analogous to `sammy-mind`'s `Consolidate` command — but triggered automatically by the infinite loop rather than by a hook.

#### Conversational Continuity

The Overmind is not stateless. Each reasoning cycle is a turn in an ongoing conversation. The LLM sees:

- **System prompt**: Identity, responsibilities, available tools, current factory portfolio summary.
- **Conversation history**: Previous reasoning cycles (compressed after consolidation), including what it evaluated, what the builder corrected, what patterns it noticed.
- **New turn**: The `SignificantBatch` — what changed since last cycle.

This means the Overmind can say: "I evaluated PR #87 two cycles ago and flagged a REST/MCP deviation. The builder redirected. Now PR #92 on a different app shows the same pattern — I'll flag it immediately with higher confidence."

A single-shot LLM call cannot do this. It has no memory of two cycles ago. It processes each batch in isolation. The persistent loop is what makes the Overmind an actual intelligence rather than a fancy formatter.

#### Example: Agent Completes with a PR

```
SignificantBatch: agent oh-task-dm-42 completed with PR #87 on issue #42
                  (label: factory:dm:build)

Overmind reasons:

  1. I need the factory spec for this app.
     → read_factory_spec("dm")
     → Cached: "MemexModule with tools: dm_generate_encounter (Effect),
        dm_present_encounter (Pure) → EncounterCard. MCP pattern per platform."

  2. I need the PR diff.
     → read_pr_diff(87)
     → Adds src/dm/module.rs, registers tools via REST handler pattern,
       uses reqwest for external API calls...

  3. Something's off. The spec says MCP, the PR uses REST. Let me check
     if I've seen this before.
     → search_evaluations("MCP vs REST tool registration deviation")
     → Hit: PR #65 on issue #38, same drift. Builder redirected with
       "Use MCP tool registration pattern, not REST handlers."

  4. This is a known drift pattern. High confidence.
     → emit_evaluation({
         issue: 42, pr: 87,
         verdict: "drifted",
         deviations: ["Uses REST handler pattern; spec requires MCP"],
         confidence: "high",
         precedent: "Same drift on PR #65, builder redirected"
       })

  5. This needs the builder's attention.
     → emit_attention({
         source: { type: "issue", number: 42 },
         summary: "PR #87 uses REST handlers — spec requires MCP. Same drift as PR #65.",
         urgency: "high",
         action: { type: "redirect", target: 42 }
       })
```

Five tool calls, grounded reasoning, precedent-based confidence. A single-shot dump-and-pray call would have had to contain the full PR diff, all factory specs, and all past evaluations in one prompt — and would still hallucinate half the time because it can't search selectively.

#### Building Blocks from memex-core

The Overmind is built on existing platform infrastructure, not from scratch:

| Building block | Source | Use in Overmind |
|---|---|---|
| `MemexModule` trait | `memex-core/modules` | Tool definitions, storage init, lifecycle |
| `ClaudeClient` / `light_llm` | `memex-core/llm`, `memex-core/light_llm` | LLM calls — Haiku for fast gating, Sonnet for deep evaluation |
| Agentic tool dispatch | `memex-core/agentic/engine` | Multi-step tool-use reasoning within each cycle |
| LanceDB storage | `memex-core/storage`, `sammy-mind/db` | Tables, schemas, vector search, CRUD |
| Embedding client | `memex-embedding` | Embed factory specs, evaluations for semantic search |
| Significance gating | `sammy-mind/gate` | Filter noise, batch significant changes |
| Consolidation | `sammy-mind/consolidate` | Compress conversation, distill wisdom |

The Overmind is a workspace member of the memex Cargo workspace — same pattern as `sammy-mind`. Path dependencies on `memex-core`, `memex-embedding`, `memex-storage`. Built alongside everything else.

```
memex/
├── Cargo.toml              # workspace — add "heimdall-overmind" to members
├── memex-core/             # agentic loop, modules, LLM client
├── memex-embedding/        # embedding proxy
├── memex-storage/          # LanceDB
├── sammy-mind/             # precedent — same pattern
├── heimdall-overmind/      # ← lives here
│   ├── Cargo.toml          # path deps: memex-core, memex-embedding, memex-storage
│   └── src/
│       ├── main.rs         # daemon — connect, loop forever
│       ├── gate.rs         # significance filter
│       ├── tools.rs        # tool implementations
│       ├── memory.rs       # LanceDB tables
│       └── ...
└── ...
```

#### Data Grounding

The Overmind must never hallucinate data. Every claim must trace to a real read:

| Tool | Data source | Access method |
|---|---|---|
| `read_issue(n)` | GitHub | Direct GitHub API (repo token) |
| `read_pr_diff(n)` | GitHub | Direct GitHub API (`GET /repos/:owner/:repo/pulls/:n/files`) |
| `read_factory_spec(app)` | Overmind's LanceDB | Populated by reading real issue bodies on first encounter |
| `search_evaluations(q)` | Overmind's LanceDB | Vector search over past verdicts it actually produced |
| `search_builder_corrections(q)` | Overmind's LanceDB | Vector search over real builder actions |
| `get_portfolio_snapshot()` | Miranda API | `GET /api/portfolio/stream` or one-shot endpoint |

Credentials: `GITHUB_TOKEN` (same one Miranda uses) + `MEMEX_LICENSE` (for LLM proxy via memex-core). Both are environment variables that already exist in the deployment.

The hybrid data strategy: Miranda provides the *what changed* (SSE events — which agent completed, which CI check flipped), GitHub provides the *content* of what changed (issue bodies, PR diffs). The Overmind never fabricates either.

#### What the Overmind Is Not

The Overmind is hand-built. It is the one piece of Heimdall that cannot be factory-produced by Miranda's oh-task pipeline. It requires iterative development: tool design, gating thresholds, consolidation strategy, prompt engineering, false-positive calibration. The engine touch, portfolio state model, surface, audit, and critique are all factory-workable — bounded, well-specified, mechanical. The Overmind is the judgment layer that makes all of those worth having.

#### Two Speeds (unchanged)

The world layer operates at two speeds, like a game engine:

**Fast loop (mechanical, every SSE tick, <10ms):**
- Session status changes (starting → working → asking → done)
- Agent heartbeat state (which agents are active, what status)
- Issue marker positions (which phase, which status)
- PR mechanical state (CI passing/failing, conflicts yes/no)
- Capacity counts (slots used/total)
- Pulse derivation from mechanical state

Computed from structured data with deterministic code. The render loop. The surface stays responsive because the mechanical layer never waits on the Overmind.

**Slow loop (Overmind, on significant state changes):**
- The infinite agentic loop runs a reasoning cycle
- Multi-step tool use: read diffs, read specs, search history, compare, conclude
- Takes seconds per cycle, but produces grounded judgments — not guesses
- The surface never blocks on it; Overmind state arrives asynchronously

The portfolio state model carries both:

```typescript
interface PortfolioState {
  // ... existing mechanical fields ...

  /** Semantic state produced by the Overmind. */
  /** Updated asynchronously — may lag mechanical state by seconds. */
  overmind: {
    /** Last time the Overmind completed a reasoning cycle. */
    processedAt: string;

    /** Is the Overmind currently in a reasoning cycle? */
    reasoning: boolean;

    /** Attention items with grounded summaries. */
    attention: AttentionItem[];

    /** Per-issue semantic context (factory spec summary, evaluation verdict). */
    issueContext: Record<number, IssueSemanticContext>;

    /** Automation decisions pending (default actions waiting for override window). */
    pendingDefaults: DefaultAction[];

    /** How many reasoning cycles since last consolidation. */
    cyclesSinceConsolidation: number;

    /** Total reasoning cycles since Overmind start. */
    totalCycles: number;
  };
}

interface IssueSemanticContext {
  /** Overmind-generated one-line summary of what this issue specifies. */
  specSummary: string;

  /** Evaluation verdict from grounded analysis, if applicable. */
  evaluationVerdict: "aligned" | "drifted" | "wrong_approach" | null;

  /** Specific deviations found, with evidence references. */
  deviations: string[] | null;

  /** Confidence level, informed by precedent. */
  confidence: "high" | "medium" | "low" | null;

  /** Reference to past similar evaluations, if any. */
  precedent: string | null;
}

interface DefaultAction {
  /** What triggered this. */
  trigger: string;

  /** What the system will do. */
  action: StateAction;

  /** Overmind's reasoning for choosing this action — grounded, not template. */
  reasoning: string;

  /** When this was created — used for the override window. */
  createdAt: string;

  /** Whether the builder has intervened. */
  overridden: boolean;
}
```

The surface renders mechanical state immediately (heartbeats, markers, positions) and overlays Overmind state as it arrives (attention items, summaries, evaluation badges). The surface never blocks on the Overmind.

#### What Stays Mechanical

Not everything goes through the Overmind. The mechanical layer (deterministic code) handles:

- Heartbeat animation state (which agents are alive, what status)
- Issue marker positions (computed from structured GitHub data)
- Phase column layout (computed from labels)
- Capacity counting (simple arithmetic)
- Pulse derivation (first-match rule on mechanical state)
- SSE event routing and debounce
- Action dispatch execution (calling engine endpoints)

The rule: if it can be derived from structured data with a simple rule, it's mechanical. If it requires reading human-written text, making a judgment call, producing human-readable output, or learning from past experience, it goes to the Overmind.

### 12.4 The Boundary

**The rule:** The world calls down into the engine. The engine never calls up into the world. The engine emits events; the world subscribes. The engine exposes state; the world reads it. The engine provides `spawn(prompt, cwd) → sessionId`; the world decides what prompt to send. The Overmind decides *what* the world should do; mechanical code executes it.

### 12.5 What This Enables

Because the engine is prompt-agnostic and the world has a brain:

1. **Define new skill types without touching Miranda.** A new situation arises — the Overmind composes a prompt and hands it to the engine.
2. **Enrich existing skills with context.** The Overmind reads the factory spec and layers relevant context onto any base skill template.
3. **Build different worlds on the same engine.** The portfolio surface is one world. The Overmind's prompt is the only thing that changes.
4. **Evolve the action vocabulary independently.** New actions, new evaluation criteria, new automation rules — all in the Overmind's prompt, not in code.
5. **Handle edge cases without code changes.** An unusual factory spec format? The LLM reads it anyway. A novel failure mode? The LLM reasons about it. The system degrades gracefully instead of crashing on an unparsed edge case.

### 12.6 Required Engine Addition

Miranda needs exactly one new capability to support the world cleanly:

```
POST /api/sessions/spawn
Body: { prompt: string, cwd: string, label?: string }
Returns: { sessionId: string }
```

A generic "run this prompt" endpoint. The `label` is an opaque string for tracking. This is the only engine change. Everything else is world.

Existing skill-specific endpoints remain for backward compatibility with the Telegram bot. They're sugar over `spawn`.

## 13. Action Layer

The portfolio surface is not read-only. The builder directs workers by dispatching agents to handle situations. This is the RTS control model: select, issue an order, it executes autonomously.

### 13.1 Skills Are Prompts

The dispatch path today:

```
SKILL.md (markdown file)
  → loadSkillContent() strips frontmatter, appends args
  → sendPrompt(agent, promptString)
  → oh-my-pi executes the prompt
```

The agent doesn't know or care where the prompt came from. `oh-ci` is a markdown file that becomes a prompt. `oh-task` is a prompt that says "work this GitHub issue." **Any prompt can be an agent session.**

Pre-built skills are the unit types — Marines, Medics, Siege Tanks. Reusable, battle-tested, always available. You don't remove them because you can also compose custom prompts. They're the vocabulary.

### 13.2 Prompt Factory

The prompt factory composes situation-specific prompts from building blocks:

```
Factory context (what the app should be)
  + Issue spec (what this slice should do)
  + Situation (what went wrong / what's needed)
  + Builder guidance (human direction, optional)
  + Base template (pre-built skill, optional)
  = Composed prompt
```

```typescript
interface PromptComposition {
  /** Base template — a pre-built skill name, or null for fully composed. */
  base: string | null;

  /** Factory context: the app-factory's spec for this app. */
  factoryContext: {
    aim: string;
    domainMap: string;
    designTone: string;
  } | null;

  /** Issue context: the spec for this specific slice. */
  issueContext: {
    number: number;
    title: string;
    body: string;
  } | null;

  /** Situation: what triggered this dispatch. */
  situation: string;

  /** Builder guidance: human direction (optional). */
  guidance: string | null;
}
```

Assembled prompt structure:

```
## Factory Context
<aim + domain map + design tone>

## Issue Specification
<issue body — the ground truth for this slice>

## Situation
<what went wrong or what's needed>

## Builder Guidance
<human direction, if any>

## Task
<base skill template, adapted to context above — or fully composed task>
```

For non-factory work (standalone repos, one-off tasks), `factoryContext` and `issueContext` are null — the prompt is just the base skill template + situation, same as today.

### 13.3 Action Types

The surface presents actions computed from the current state. Each action dispatches either a composed prompt to the engine's spawn endpoint, or a direct call to an existing engine REST endpoint.

```typescript
interface StateAction {
  id: string;
  label: string;
  style: "primary" | "secondary" | "danger";
  acceptsGuidance: boolean;
  dispatch: ActionDispatch;
}

type ActionDispatch =
  | {
      type: "compose";
      base: string | null;
      target: string;
      project: string;
      situation: string;
    }
  | { type: "api"; method: "POST" | "DELETE"; path: string; body?: Record<string, unknown> }
  | { type: "respond"; sessionKey: string; requestId: string }
  ;
```

When the surface dispatches a `compose` action:
1. World layer composes the prompt (prompt factory + factory context + builder guidance)
2. World layer calls engine: `POST /api/sessions/spawn` with the composed prompt
3. Engine spawns agent, returns session ID
4. Portfolio state updates as the agent runs

The compose step happens in the world, not the engine. The engine only sees a prompt string.

### 13.4 Action Autonomy Levels

Not all actions are equal. The action space has three tiers of autonomy:

| Level | Meaning | Surface treatment |
|---|---|---|
| **Automatic** | System does it. Builder sees the result, not the decision. | No button. Visible as state transition (marker changes, heartbeat appears). |
| **Default** | System does it unless builder overrides. One-tap to intervene. | Peripheral toast. Override available briefly. |
| **Manual** | Builder decides. System presents the action, waits. | Action button in attention strip or on hover. |

#### Automatic Actions (the belt — work flows, builder watches)

| Trigger | Action | Why automatic |
|---|---|---|
| Dependent issue unblocked (parent PR green) | Start `oh-task` for the issue | **Already automated by Miranda’s scheduler.** Dep graph + concurrency limiter handle this. |
| `oh-task` signals success with PR | Dispatch alignment evaluation | Cheap, fast, no downside. Builder sees the verdict, not the dispatch decision. |
| Evaluation verdict = `aligned` | Move issue to normal review flow | Happy path is silent. No intervention needed. |
| PR passes CI + review + no conflicts | Auto-merge (if enabled per-app) | The pipeline flows. Builder can disable per-app. |

These never show action buttons. They show *consequences* — a new heartbeat appearing, a marker transitioning, an issue drifting rightward. The factory is running. This is the calm texture.

#### Default Actions (the inserter — handled routinely, override if needed)

| Trigger | Default action | Override |
|---|---|---|
| PR CI fails | Dispatch `oh-ci` (enriched with factory context) | Builder can tap to add guidance before dispatch, or cancel |
| PR has merge conflicts | Dispatch `oh-conflict` (enriched) | Builder can tap to provide guidance or handle manually |
| PR review has changes requested | Dispatch `oh-notes` (enriched) | Builder can redirect or provide specific guidance |

These show a brief peripheral indicator: *"CI fix dispatched for PR #87"* with a small [Edit] affordance. If the builder does nothing (likely — these are routine), the system handles it. Tap within a few seconds to add guidance or cancel. After the window, the agent is already working.

Surface treatment: the issue marker transitions normally. The toast is part of the rhythm — peripheral, not demanding. You notice it the way you notice an inserter picking something up in Factorio.

**Per-app configuration dial:**
- Auto-fix CI: on (default) / off / ask-first
- Auto-resolve conflicts: on (default) / off
- Auto-address feedback: on / off (default — CR feedback often needs human judgment)
- Auto-merge: off (default) / on when CI+review green

Crank the dial up for trusted pipelines, dial it back for new or risky apps. This is the factory automation level.

#### Manual Actions (the command card — builder decides and directs)

| State | Action | Guidance | Why manual |
|---|---|---|---|
| Root issue, no agent | "Start" | yes | First issue in a chain — builder decides when to begin |
| Agent asking a question | "Answer" | — | Only a human can answer |
| Agent working, wrong approach | "Redirect" | **yes** | Requires human judgment about what went wrong |
| Evaluation: `alignment_drift` | "Fix Drift" | **yes** | Builder must read the deviation and decide correction |
| Evaluation: `wrong_approach` | "Restart" | **yes** | Builder must provide new direction |
| Agent working (any) | "Stop" | no | Destructive — builder decides |
| PR ready, auto-merge off | "Merge" | no | Builder chooses merge timing |
| Portfolio level | "Plan New App" | — | Strategic — only builder initiates |
| App level | "Pause" / "Resume" | no | Strategic — builder manages capacity |

These show action buttons in the attention strip or inline on hover/focus. The builder acts deliberately.

#### The Ratio

A healthy pipeline is ~70% automatic, ~20% default, ~10% manual. If the builder is constantly in the manual layer, something is wrong with the pipeline or the factory spec. The surface should *feel* like it mostly runs itself, with the builder stepping in for the hard stuff.

The three levels create three layers of visual activity:
1. **Automatic = the belt.** Work flowing. Heartbeats appearing. Markers transitioning. The calm texture that makes you want to watch.
2. **Default = the inserter.** Peripheral, routine, handled. Visible but not demanding. Interruptible if needed.
3. **Manual = the command card.** Infrequent but powerful. Each action matters. This is the RTS moment — selecting a unit, issuing an order.

### 13.5 The Enrichment Gradient

## 14. Factory Context — The Reference Frame

### 14.1 The Problem of Semantic Deviation

Mechanical problems are easy: CI red, agent stuck, merge conflict. The portfolio state handles these.

Semantic problems are hard: the agent is confidently building the wrong thing. CI passes. The agent isn't stuck. But the approach diverges from what the app-factory specified. Without the factory context, this is invisible.

### 14.2 What the Factory Codifies

When `/app-factory` plans an app, it produces:

- **Aim:** Who is the user, what behavior change, what feedback signal
- **Domain map:** Tools (name, category, card, description), state, storage, design tone
- **Issue descriptions:** Each issue body contains the full spec for that slice — tool table, card designs, system prompt direction, acceptance criteria
- **Design tone:** Aesthetic direction, anti-references, use context
- **Dissent findings:** Pre-mortem corrections applied during planning

This is the ground truth. "Wrong approach" = the agent's output doesn't align with what the factory specified.

### 14.3 Where Factory Context Lives

1. **GitHub issue bodies** — Each factory issue contains the full spec for its slice (primary source)
2. **`.oh/<session>.md`** — Session file with aim, domain map, issue list (if session persistence was used)
3. **Factory labels** — `factory:<app>:<phase>` on each issue (already parsed by portfolio state)

The world layer caches parsed factory specs per app, refreshed on scheduler poll, keyed by app name from labels.

### 14.4 Alignment Evaluation

The prompt factory composes evaluation prompts grounded in the specific factory spec:

```
## Factory Context
App: DungeonMaster
Aim: DMs run more dynamic encounters using AI-generated content
Design tone: warm parchment, hand-drawn feel, fantasy aesthetic

## Issue Specification (Issue #42: dm-module)
Implement MemexModule trait with tools:
- dm_generate_encounter (Effect) — generate encounter from parameters
- dm_present_encounter (Pure) → EncounterCard — formatted encounter
- dm_recall_encounters (Pure) — semantic search past encounters
State: active encounter, party composition
Storage: encounters table with embeddings
System prompt: knowledgeable DM assistant, uses D&D 5e rules

## Task
Evaluate PR #87 against the issue specification above.
Read the PR diff. For each aspect of the spec, assess:
- Does the implementation match what was specified?
- Are there additions not in the spec? (scope creep)
- Are there omissions from the spec? (incomplete)
- Does the approach align with the platform patterns?

Produce a verdict: aligned, drifted (list deviations), or wrong_approach.
Signal completion with the verdict.
```

No pre-written `oh-evaluate` skill. The prompt factory composes this at dispatch time, grounded in the exact factory spec. The evaluating agent knows what the PR should look like because the factory told it.

### 14.5 Automatic Evaluation Pipeline

When a factory-labeled `oh-task` agent signals `completion: success` with a PR:

1. World layer detects: factory-labeled issue, agent completed with PR
2. Prompt factory composes alignment evaluation prompt (§14.4)
3. World layer calls engine: `POST /api/sessions/spawn` with the evaluation prompt
4. Evaluation agent reads issue spec + PR diff, produces verdict
5. Verdict flows back through `signal_completion`
6. Portfolio state updates:
   - `aligned` → issue moves to normal review flow (routine)
   - `drifted` → attention item: `alignment_drift` with deviation list
   - `wrong_approach` → attention item: `wrong_approach` with explanation
7. Builder sees the attention item, can dispatch "Fix Drift" or "Restart" (both accept guidance)

The builder's attention cost: read one summary, optionally type one sentence. The world handles discovery, context assembly, and re-dispatch.

### 14.6 Attention Types for Semantic Deviation

```typescript
type AttentionType =
  // ... existing mechanical types ...
  | "alignment_drift"     // evaluation found deviations from factory spec
  | "wrong_approach"      // evaluation found fundamental approach mismatch
  ;
```

```typescript
interface AttentionContext {
  // ... existing fields ...

  /** Alignment evaluation results. */
  evaluation: {
    verdict: "drifted" | "wrong_approach";
    deviations: string[];
    issueSpec: string;
  } | null;
}
```

### 14.7 IssueState Additions

```typescript
interface IssueState {
  // ... existing fields ...

  /** One-line summary of what this issue specifies. */
  specSummary: string | null;

  /** Whether alignment evaluation has run on the latest PR. */
  evaluated: boolean;

  /** Latest evaluation verdict. */
  evaluationVerdict: "aligned" | "drifted" | "wrong_approach" | null;
}
```

### 14.8 The Full Cycle

```
1. oh-task agent works issue #42 (factory:dm:build)
2. Agent signals success with PR #87
3. Portfolio state: IssueState → "in_review"
4. World auto-dispatches evaluation prompt grounded in issue #42 spec
5. Evaluation agent: verdict = "drifted" — REST API instead of MCP pattern
6. Attention item surfaces: "PR #87 uses REST; spec says MCP"
7. Builder taps "Fix Drift", types: "Use MCP tool pattern per the issue spec"
8. World composes prompt: oh-task base + factory context + deviation list + builder guidance
9. Engine spawns agent with the composed prompt
10. Agent reads spec, reads builder guidance, builds correctly
```

## 15. Implementation Sequence

### Phase 1: Engine Touch (minimal)
1. Add `lastToolActivityAt` to `Session` interface in `types.ts`
2. Update `handleAgentEvent` in `events.ts` to set `lastToolActivityAt` on tool events
3. Add `POST /api/sessions/spawn` endpoint (generic prompt runner)

### Phase 2: Mechanical State Model (World — deterministic)
4. Create `src/portfolio/types.ts` with all types from this spec (mechanical + Overmind slots)
5. Create `src/portfolio/state.ts` — `computeSnapshot()` for mechanical state
6. Mechanical attention derivation (CI failing, agent asking, stale, crashed — rule-based)
7. Tests for snapshot correctness + invariants

### Phase 3: SSE Integration (World → Engine bridge)
8. Create `src/portfolio/stream.ts` — SSE endpoint, debounce, subscriber management
9. Hook into engine event flow
10. Wire: `/api/portfolio/stream`

### Phase 4: Overmind (Rust daemon, memex-core)
11. Create `heimdall-overmind/` crate — binary, depends on `memex-core`, `memex-embedding`
12. Implement Overmind as `MemexModule`: tool definitions, LanceDB storage init (factory_contexts, evaluations, builder_corrections, attention_log, wisdom tables)
13. SSE listener: subscribe to Miranda's portfolio stream, parse events
14. Significance gate: filter noise (heartbeats, working↔thinking flips), batch real changes into `SignificantBatch`
15. Agentic loop: on significant batch, enter reasoning cycle — LLM + tools (read_issue, read_pr_diff, read_factory_spec, search_evaluations, search_builder_corrections, emit_attention, emit_evaluation, emit_automation_decision, compose_prompt, request_spawn)
16. Judgment emitter: write Overmind output back to Miranda's portfolio state model (HTTP endpoint or SSE reverse channel)
17. Consolidation: periodic conversation compression, wisdom distillation, attention log pruning
18. Conversational continuity: conversation history across cycles, system prompt with portfolio summary, compressed history on consolidation

### Phase 5: Prompt Factory + Actions (World, powered by Overmind)
19. Overmind tool `compose_prompt()` — context-aware prompt composition grounded in factory spec + situation + builder preferences from memory
20. Compute available actions per state object (autonomy levels: automatic, default, manual)
21. Wire default-action dispatch with override window
22. Wire manual actions from attention strip

### Phase 6: Evaluation Pipeline (World, powered by Overmind)
23. On agent completion with PR on factory issue → Overmind enters evaluation reasoning cycle (reads spec, reads diff, searches precedent, concludes)
24. Wire verdicts back into portfolio state
25. Semantic attention types (`alignment_drift`, `wrong_approach`) with precedent references

### Phase 7: Surface
26. Static layout — hardcoded snapshot, get spatial composition + typography + color right
27. SSE subscription — live state rendering (mechanical + Overmind overlays)
28. Heartbeats — agent pulse animations (the surface comes alive)
29. Spatial transitions — issues drift between phases, markers appear/fade
30. Actions — inline answer, redirect, dispatch
31. Responsive — container queries for tablet/phone
32. Dark mode + polish

### Phase 8: Validation
33. End-to-end: factory build → Overmind reasons over completion → evaluates with tools → builder redirects → Overmind learns correction → flags same pattern preemptively on next occurrence
34. Tune: Overmind tool quality, significance gate thresholds, consolidation frequency, default-action windows, heartbeat aesthetics

---

## 16. Surface Design — The Living Map

This section defines the visual language, interaction model, and aesthetic principles for the portfolio surface. The surface is a pure renderer of the portfolio state model (§2–§10). It subscribes to the SSE stream, renders state, accepts builder commands, and dispatches actions back to the engine.

### 16.1 Design Intent

**Purpose:** Solo builder manages a portfolio of concurrent AI app builds from a single ambient surface. Glance and know. Attention is the scarce resource.

**Tone:** Cartographic minimalism. Dense, authoritative, precise. Every mark earns its place. Not a dashboard — a living map of work. Think: Edward Tufte meets a nautical chart meets a war room plotting table.

**The unforgettable thing:** The surface breathes. Active agents have heartbeats — slow, rhythmic opacity pulses. Work flows spatially from left to right through pipeline phases. Disruptions in the rhythm are what catch your eye, not alerts. You come back because you want to see your factory running.

**Differentiation from dashboards:** Dashboards present data in cards and charts. This surface presents *rhythm*. The information is encoded in spatial position, typographic weight, color temperature, and motion cadence. You read it the way you read a Factorio factory — not by parsing labels, but by seeing patterns.

### 16.2 Why You Come Back

The surface must create a game-loop pull. Five principles, all borrowed from games that people play for thousands of hours:

1. **Your creation is alive.** The heartbeats are YOUR workers. The flow is YOUR pipeline. Ownership creates the pull. This is the Factorio effect — you watch because you built it and it's running.

2. **Progress is visceral.** Issues drift rightward as they complete. Phases fill in. The landscape transforms over hours. The Civilization effect — you built that from nothing, you want to see what's next.

3. **Rhythm is addictive.** The heartbeats, the flow, the quiet hum of agents working. The belt-and-inserter effect. You don't need to do anything. Watching confirms the system is running. That confirmation feels good.

4. **Disruption is engaging, not annoying.** When rhythm breaks, you WANT to fix it — not because an alert nags, but because the beautiful pattern got disrupted and your brain wants it restored. The factory-jam effect.

5. **Actions feel powerful.** Dispatch an agent → new heartbeat appears. Provide guidance → redirected agent picks up work. Merge a PR → issue flows downstream into done. Every action has a visible, satisfying consequence in the world.

### 16.3 The Engagement Loop

The surface supports a tight glance-scan-focus-act-watch cycle, identical to the RTS attention loop:

```
1. GLANCE → Portfolio pulse. Calm? Move on. Shifted? Step 2.
2. SCAN  → Which region changed? Spatial layout tells you without reading.
3. FOCUS → What specifically? Attention item: one-line summary, right there.
4. ACT   → Dispatch, answer, redirect, merge. From the surface. No navigation.
5. WATCH → See the consequence: new heartbeat, resumed rhythm, issue flowing.
6. Return to 1.
```

**Critical constraint:** Steps 1–3 must take under 2 seconds. The builder glances, scans, and focuses in one fluid motion. If they have to parse a table or open a panel, the loop is broken.

### 16.4 Spatial Layout

The surface is a single full-viewport composition. No pages, no navigation, no routing. One screen.

```
┌─────────────────────────────────────────────────────────────┐
│  Portfolio Pulse              Capacity ○ ○ ○ ● ●   [+New]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ── app: dungeon-master ─────────────────────────────────   │
│                                                             │
│     build                 audit              critique       │
│     ┈┈┈┈┈┈┈┈┈┈┈┈         ┈┈┈┈┈┈┈┈┈         ┈┈┈┈┈┈┈┈      │
│     #42 dm-module  ●◉     #48 a11y   ○       #51 review ○  │
│     #43 dm-cards   ●◉     #49 perf   ○                     │
│     #44 dm-state   ◎                                       │
│     #45 dm-storage ○                                       │
│     #46 dm-prompt  ○                                       │
│                                                             │
│  ── app: crm ────────────────────────────────────────────   │
│                                                             │
│     build                 audit              critique       │
│     ┈┈┈┈┈┈┈┈┈┈┈┈         ┈┈┈┈┈┈┈┈┈         ┈┈┈┈┈┈┈┈      │
│     #30 crm-contacts ●◉  #35 a11y   ○                      │
│     #31 crm-pipeline  ◎                                    │
│     #32 crm-dash      ○                                    │
│                                                             │
│  ── app: weather ────────────────────────────────────────   │
│                                                             │
│     build                 audit                             │
│     ┈┈┈┈┈┈┈┈┈┈┈┈         ┈┈┈┈┈┈┈┈┈                        │
│     #60 weather-mod  ✓   #63 a11y   ○                      │
│     #61 weather-ui   ●◉                                    │
│     #62 weather-data ◎                                     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Attention                                                  │
│  ▸ #42 dm-module: agent asking — "Which MCP pattern?"       │
│  ▸ #30 crm-contacts: CI failing on PR #87                   │
└─────────────────────────────────────────────────────────────┘
```

#### Marker Legend

| Marker | State | Visual |
|---|---|---|
| `○` | Queued / waiting on deps | Hollow, dim, receding |
| `◎` | Ready / deps resolved | Hollow, warm, present |
| `●◉` | Agent working (heartbeat) | Filled, pulsing — the breathing marker |
| `●◈` | Agent asking (frozen pulse) | Filled, pulse halted — rhythm break |
| `●!` | Agent error / attention | Filled, accent color — the signal fire |
| `⟳` | In review (PR exists) | Rotating slowly — the evaluation state |
| `✓` | Done | Check, fading into ground — completed work recedes |

#### Regions

Each app is a horizontal **region** — a band across the surface. Regions are vertically stacked. Within each region:

- **Phase columns** flow left to right: build → audit → critique
- **Issues** are positioned within their phase column
- **Agents** are shown as markers on their issue
- **PRs** modify the issue's marker (adding CI/review indicators)

Phase columns are not equal-width. The active phase (the one with agents working) gets more visual space. Done phases compress. Pending phases are present but minimal. The layout breathes — attention follows activity.

#### The Attention Strip

Below the regions: the attention strip. Items requiring human attention, ranked by urgency. Each item is a single line — enough to understand and act without expanding anything:

```
▸ #42 dm-module: agent asking — "Which MCP pattern for tools?"     [Answer]
▸ #30 crm-contacts: CI failing on PR #87 — test_pipeline_flow      [Fix CI]
▸ #61 weather-ui: alignment drift — uses REST, spec says MCP       [Redirect]
```

Each line has the action button inline. Tap it and you're acting. No modals, no panels, no navigation. The surface is the interface.

For questions: the answer input appears inline when you tap [Answer]. A single text field expands below the attention line. Type, hit enter, field collapses, heartbeat resumes. The surface absorbed the interaction.

### 16.5 The Heartbeat

The most important visual element. This is what makes the surface alive.

An active agent is a **breathing marker** — a slow, rhythmic opacity/scale pulse:

```css
@keyframes heartbeat {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50%      { opacity: 1.0; transform: scale(1.15); }
}

.agent-marker.working {
  animation: heartbeat 3s ease-in-out infinite;
}
```

Different states, different rhythms:

| Agent Status | Animation | Why |
|---|---|---|
| `starting` | Quick pulse, 1s cycle | Spinning up — energy |
| `working` | Slow breath, 3s cycle | Steady, healthy, productive |
| `thinking` | Medium pulse, 2s cycle | Processing — slightly elevated |
| `asking` | Pulse **frozen** at peak opacity | Rhythm break — your eye catches stopped clocks |
| `error` | Single pulse, then holds at low opacity | Stuttered heartbeat — something's wrong |
| `blocked` | No animation, dimmed | Flatline — needs intervention |
| `done` | Fade out over 2s | Heartbeat ends — work complete |

**The frozen pulse is the key insight.** You don't notice an agent asking because of color or an icon. You notice because one of the heartbeats *stopped*. Your peripheral vision is tuned to detect rhythm breaks. A stopped clock in a room of ticking ones.

**Multiple heartbeats create polyrhythm.** Three agents working at 3s cycles but started at different times create a subtle visual rhythm — like watching three pendulums. This is the Factorio belt effect. The polyrhythm itself is the ambient texture. Disruptions stand out.

### 16.6 Color System

OKLCH throughout. The palette is 90% warm neutrals with one accent that only appears for attention.

#### Ground Tones (The Map Surface)

```css
:root {
  /* The warm ground — aged paper, not white, not dark */
  --ground-0: oklch(96% 0.015 75);    /* lightest — page background */
  --ground-1: oklch(92% 0.012 75);    /* surface — region backgrounds */
  --ground-2: oklch(86% 0.010 75);    /* receding — done items, borders */
  --ground-3: oklch(78% 0.008 75);    /* mid — secondary text, phase labels */
  --ground-4: oklch(65% 0.006 75);    /* strong — issue titles, data */
  --ground-5: oklch(35% 0.010 75);    /* ink — primary text, app names */
}
```

Hue 75 (warm amber) tints all neutrals. Even the darkest tone has warmth. No pure black, no pure gray, no dead colors.

#### Status Tones

```css
:root {
  /* Agent heartbeats — warm, alive */
  --pulse-active: oklch(65% 0.12 55);   /* warm amber — healthy work */
  --pulse-thinking: oklch(60% 0.10 55); /* slightly deeper */

  /* Progress — cool calm */
  --done: oklch(75% 0.04 150);           /* sage green — completed, receding */
  --review: oklch(70% 0.06 230);         /* muted blue — in review */

  /* Attention — the signal fire */
  --attention: oklch(55% 0.18 25);       /* burnt sienna — impossible to miss */
  --attention-bg: oklch(90% 0.04 25);    /* warm wash behind attention items */

  /* Waiting — color temperature shift */
  --waiting: oklch(65% 0.08 250);        /* cool blue — cloud shadow */
}
```

#### The Accent Economy

The attention accent (`--attention`) appears ONLY for items in the attention strip and for markers with `●!` state. Nowhere else. Not in headers, not in buttons, not in decorative elements. The accent works because it's rare. If 10% of the surface is accent-colored, it's broken.

**The temperature model:** The surface has a default warm temperature (ground tones). Healthy work maintains warmth (agent heartbeats are warm amber). Waiting states introduce cool tones — a perceptible but gentle temperature shift. Errors and attention items are warm again but *hotter* — burnt sienna, not amber. The temperature gradient: cool-waiting → warm-calm → hot-attention.

### 16.7 Typography

#### Typefaces

**Display: Fraunces** — A variable serif with warmth, personality, and optical sizing. Used for app names and phase labels. Its soft terminals and organic rhythm match the cartographic aesthetic. The `WONK` axis gives it character without being playful.

**Data: Plus Jakarta Sans** — Clean, geometric, but with enough personality to not disappear. Used for issue titles, agent status, timestamps, and the attention strip. Tabular figures for alignment.

```css
@font-face {
  font-family: 'Fraunces';
  src: url('/fonts/Fraunces-Variable.woff2') format('woff2');
  font-display: swap;
  font-weight: 100 900;
  font-style: normal;
}

@font-face {
  font-family: 'Plus Jakarta Sans';
  src: url('/fonts/PlusJakartaSans-Variable.woff2') format('woff2');
  font-display: swap;
  font-weight: 200 800;
  font-style: normal;
}
```

#### Type Scale (Modular, Major Third — 1.25)

```css
:root {
  --text-xs:   clamp(0.64rem, 0.6rem + 0.2vw, 0.75rem);   /* timestamps, meta */
  --text-sm:   clamp(0.8rem, 0.75rem + 0.25vw, 0.875rem);  /* secondary labels */
  --text-base: clamp(0.95rem, 0.9rem + 0.3vw, 1rem);       /* issue titles, data */
  --text-lg:   clamp(1.15rem, 1.05rem + 0.4vw, 1.25rem);   /* phase labels */
  --text-xl:   clamp(1.4rem, 1.25rem + 0.6vw, 1.563rem);   /* app names */
  --text-2xl:  clamp(1.75rem, 1.5rem + 0.8vw, 1.953rem);   /* portfolio pulse */
}
```

#### Typographic Hierarchy

| Element | Font | Weight | Size | Color |
|---|---|---|---|---|
| Portfolio pulse label | Fraunces | 500 | `--text-2xl` | `--ground-5` |
| App name | Fraunces | 600 | `--text-xl` | `--ground-5` |
| Phase label | Fraunces | 400 | `--text-lg` | `--ground-3` |
| Issue title | Plus Jakarta Sans | 500 | `--text-base` | `--ground-4` |
| Agent status | Plus Jakarta Sans | 400 | `--text-sm` | `--ground-3` |
| Timestamp / meta | Plus Jakarta Sans | 400 | `--text-xs` | `--ground-3` |
| Attention item | Plus Jakarta Sans | 600 | `--text-base` | `--attention` |
| Attention action | Plus Jakarta Sans | 500 | `--text-sm` | `--ground-5` |

**OpenType features:**
```css
.data { font-variant-numeric: tabular-nums; }
.phase-label { font-variant-caps: all-small-caps; letter-spacing: 0.05em; }
```

### 16.8 Motion Language

All motion serves information. Nothing decorates.

#### Transition Types

| Transition | Duration | Easing | Trigger |
|---|---|---|---|
| Issue status change | 500ms | ease-out-quart | State snapshot update |
| Issue spatial drift (phase → phase) | 800ms | ease-out-expo | Issue moves between phases |
| Agent marker appear | 300ms | ease-out-expo | New agent spawns |
| Agent marker disappear | 600ms | ease-out-quart | Agent completes — slow fade |
| Attention item enter | 400ms | ease-out-expo | New attention item |
| Attention item resolve | 300ms | ease-out-quart | Attention item dismissed |
| Region temperature shift | 1000ms | ease-in-out | App health changes |
| Inline input expand | 200ms | ease-out-quart | Builder taps action |

```css
:root {
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-expo:  cubic-bezier(0.16, 1, 0.3, 1);
}
```

#### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  /* Heartbeats become steady glow — no pulsing */
  .agent-marker { animation: none; opacity: 0.85; }

  /* Spatial drifts become instant repositioning */
  .issue-marker { transition: none; }

  /* Attention items still fade in (opacity only, no movement) */
  .attention-item { transition: opacity 200ms ease-out; }
}
```

### 16.9 Information Density

The surface must be dense without being cluttered. Density is the texture. Rules:

**1. Every element has three levels of detail.**

- **Peripheral** (glance): The marker shape + animation. You see "agent working" without reading.
- **Ambient** (scan): Issue number + short title + marker. You see "#42 dm-module, agent active" in one fixation.
- **Focused** (read): Full issue title + agent status + PR state + CI + review. You see everything when you look directly.

The surface renders all three levels simultaneously. CSS handles the hierarchy — peripheral elements are lower contrast, focused elements are full contrast. Your foveal vision picks up the detail; your peripheral vision picks up the pattern.

**2. No chrome.**

No window frames, no toolbars, no sidebars, no nav bars. The surface is edge-to-edge information. The only UI elements are the capacity indicator, the [+New] action, and the inline action buttons in the attention strip. Everything else is the map.

**3. No empty states that waste space.**

If an app has no attention items, there's no "No issues" message. The region simply has its markers in their calm state. Absence of disruption IS the information.

**4. Time is shown, not told.**

Don't show "started 5 min ago." Show the heartbeat — the viewer infers the agent is alive. Don't show "stale for 10 min." Show the dimmed marker — the viewer infers it's stuck. The only explicit timestamps are in the attention strip (for context on how long something has been waiting).

### 16.10 Interaction Model

#### Actions Live on the Surface

No modals. No panels. No drawers. No navigation. Every action is performed in-place.

**Answering a question:**
```
▸ #42 dm-module: agent asking — "Which MCP pattern?"       [Answer]
                                                                    
  becomes (on tap):                                                 
                                                                    
▸ #42 dm-module: agent asking — "Which MCP pattern?"               
  ┌──────────────────────────────────────────────────┐  [Send]      
  │ Use the tool-registration pattern from muse mod… │              
  └──────────────────────────────────────────────────┘              
```

The input field appears inline. Type, send, field collapses. Heartbeat resumes.

**Redirecting an agent:**
```
▸ #61 weather-ui: drift — uses REST, spec says MCP           [Redirect]
                                                                        
  becomes (on tap):                                                     
                                                                        
▸ #61 weather-ui: drift — uses REST, spec says MCP                     
  ┌──────────────────────────────────────────────────┐  [Dispatch]      
  │ Use MCP tool pattern per the issue spec          │                  
  └──────────────────────────────────────────────────┘                  
```

Guidance field appears. Type direction. Dispatch. Old agent killed, new one spawns. New heartbeat appears on the issue marker. The surface absorbed the entire interaction.

**Fixing CI / Resolving conflicts:**

One-tap dispatch. No guidance needed. Surface calls engine's spawn endpoint with the composed prompt. New heartbeat appears immediately — satisfying feedback.

**Merging a PR:**

One-tap. Surface calls engine's merge endpoint. Issue marker transitions from `⟳` to `✓` with a smooth fade. Issue drifts into "done" position.

#### Hover → Detail

On pointer devices, hovering over an issue marker reveals a detail tooltip (not a card — a tight, typographic detail line):

```
#42 dm-module
Agent: oh-task-dm-42 · working · 4m23s
PR #87 · CI passing · Review pending
Deps: #44 ✓, #45 ✓
```

No border, no shadow, no card. Just text appearing near the marker, anchored spatially. Recedes on pointer-out. On touch devices, this detail shows on tap (before action selection).

#### Keyboard Navigation

Tab through regions → Tab through issues → Enter to focus → Arrow keys for actions. The surface is fully keyboard-navigable. Focus indicators use the `--attention` color with 2px offset.

### 16.11 Responsive Adaptation

The surface adapts to context, not just screen size.

#### Full viewport (desktop, ~1200px+)

The composition described in §16.4. Regions stacked vertically, phases flowing horizontally. This is the primary experience — the war room view.

#### Compact viewport (tablet, ~768–1200px)

Phases stack vertically within each region instead of flowing horizontally. Region bands become taller and narrower. Attention strip moves to a sticky footer.

#### Narrow viewport (phone, <768px)

The surface becomes a vertical scroll of regions. Each region shows:
- App name + health indicator
- Compact issue list (marker + short title, no phase columns)
- Active attention items inline

On phone, the surface loses the spatial-flow metaphor but retains the heartbeat and rhythm. You still see breathing markers and frozen pulses. The engagement loop still works — just vertically instead of horizontally.

**Critical: the phone view is not a separate design.** It's the same information architecture rendered in a narrower container. Container queries (`@container`) drive the adaptation, not viewport breakpoints.

### 16.12 Empty and Edge States

**No apps yet (first-time surface):**

The surface shows the warm ground with a single element: the portfolio pulse reading "calm" and the [+New] action. No onboarding text. No explanation. The emptiness is the invitation — one button, one action.

**Single app, early build phase:**

One region. A few queued issues. Maybe one heartbeat. The surface is mostly ground with sparse markers. This is fine — it should look like a map that's being drawn. The territory reveals itself as work begins.

**All apps done:**

All markers are `✓`. All heartbeats have faded. The surface is warm and still — like a completed puzzle. The portfolio pulse reads "calm." The builder's work is finished.

**Many apps (5+):**

Regions compress vertically. Each region shows only its active phase (collapsed done/pending phases). The surface scrolls vertically if needed, but the attention strip remains sticky at the bottom — attention items are always visible.

**Agent crash (unexpected exit):**

The heartbeat stutters — one irregular pulse — then flatlines. The marker shifts to `●!`. An attention item appears in the strip. The visual treatment is distinct from "asking" (which is a frozen pulse) — a crash is a *broken* pulse, not a *stopped* one.

### 16.13 Sound Design (Future)

Not in v1, but the surface is designed to support it:

- Heartbeats could have subtle audio — a low, rhythmic tone per active agent
- Attention items could have a single, distinct chime — not a notification sound, a *spatial* sound
- Completion could have a soft resolution tone

The audio model mirrors the visual: ambient texture for routine, distinct signal for attention. Audio is additive — the surface must work perfectly without it.

### 16.14 Dark Mode

The warm ground inverts to a dark warm ground. Not pure black — dark umber.

```css
:root[data-theme='dark'] {
  --ground-0: oklch(15% 0.015 75);
  --ground-1: oklch(19% 0.012 75);
  --ground-2: oklch(24% 0.010 75);
  --ground-3: oklch(42% 0.008 75);
  --ground-4: oklch(65% 0.006 75);
  --ground-5: oklch(88% 0.010 75);

  /* Heartbeats glow against dark ground */
  --pulse-active: oklch(72% 0.14 55);

  /* Attention burns brighter */
  --attention: oklch(65% 0.20 25);
  --attention-bg: oklch(22% 0.06 25);

  /* Reduce text weight for dark backgrounds */
  --body-weight: 350;
}
```

Dark mode is not inverted light mode. Depth comes from lighter surfaces, not shadows. Heartbeats glow rather than pulse. The attention accent burns brighter against the dark ground. The cartographic aesthetic shifts from parchment-in-daylight to chart-by-lamplight.

### 16.15 Tech Stack

- **Framework:** SvelteKit — reactive model fits real-time state. Transitions and animations are first-class. The user knows the ecosystem.
- **Styling:** Plain CSS with custom properties. No utility framework. The design is too specific for Tailwind — every value is intentional.
- **Fonts:** Self-hosted variable WOFF2 (Fraunces, Plus Jakarta Sans). No external font service dependency.
- **State:** SSE subscription to Miranda's `/api/portfolio/stream`. Svelte stores for local state.
- **Actions:** REST calls to Miranda's HTTP API. `POST /api/sessions/spawn` for prompt-composed dispatches.
- **Build:** Standalone SvelteKit app. Deployed separately from Miranda. Connects to Miranda's API via configured base URL.
- **No dependencies beyond SvelteKit.** No charting libraries, no animation libraries, no component libraries. The surface is too specific for generic tools. CSS animations for heartbeats. Svelte transitions for state changes. Hand-written layout for the spatial composition.

### 16.16 Implementation Notes

The surface is Phase 6 in the implementation sequence (§15). It depends on:
- Portfolio state model being computed and available via SSE (Phases 1–3)
- Actions being computable from state (Phase 4)
- Evaluation pipeline for alignment attention items (Phase 5)

The surface can be built incrementally:

1. **Static layout** — Render a hardcoded portfolio snapshot. Get the spatial composition, typography, and color right. This is the most important step — if the static layout isn't beautiful, animation won't save it.
2. **SSE subscription** — Connect to live state. Markers update in real time. Test with a running factory build.
3. **Heartbeats** — Add agent pulse animations. This is the moment the surface comes alive.
4. **Spatial transitions** — Issues drift between phases. Markers appear and fade. The map becomes dynamic.
5. **Actions** — Wire inline answer, redirect, dispatch. The surface becomes interactive.
6. **Responsive** — Container queries for tablet/phone adaptation.
7. **Dark mode** — Theme toggle with the dark umber palette.
8. **Polish** — Timing constants, easing curves, reduced motion, keyboard nav, touch targets.