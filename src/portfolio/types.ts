// =============================================================================
// Portfolio State Types — the full game state for all concurrent factory builds.
// Ref: PORTFOLIO_STATE_SPEC §2–§10
// =============================================================================

// --- Enums -------------------------------------------------------------------

/** Aggregate system pulse. */
export type Pulse = "active" | "idle" | "blocked" | "error";

/** Overall app health derived from phase states. */
export type AppHealth = "progressing" | "waiting" | "blocked" | "stalled" | "done";

/** Phase lifecycle status. */
export type PhaseStatus = "pending" | "in_progress" | "done";

/** Issue lifecycle status. */
export type IssueStatus = "queued" | "ready" | "in_progress" | "in_review" | "done";

/** Agent session status. */
export type AgentStatus = "starting" | "running" | "waiting_input" | "stopped";

/** Attention item urgency. */
export type AttentionUrgency = "high" | "medium" | "low";

/** Attention item type. */
export type AttentionType =
  | "question"
  | "agent_error"
  | "agent_crashed"
  | "ci_failure"
  | "merge_conflict"
  | "stale_session"
  | "cycle_detected";

// --- Agent & PR state --------------------------------------------------------

export interface AgentState {
  sessionKey: string;
  skill: string | null;
  label: string | null;
  status: AgentStatus;
  startedAt: string; // ISO 8601
  lastToolActivityAt: string | null; // ISO 8601
  /** Elapsed duration in human-readable form (e.g. "12m"). */
  duration: string;
}

export interface PRState {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  /** CI overall state. */
  ci: "success" | "failure" | "pending" | "none";
  /** CodeRabbit review state. */
  review: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | null;
  /** Whether the branch is behind its base. */
  behindBase: boolean;
  /** Whether there are merge conflicts. */
  hasConflicts: boolean;
}

// --- Issue state -------------------------------------------------------------

export interface IssueState {
  number: number;
  title: string;
  /** Factory phase label (e.g. "build", "audit"). */
  phase: string | null;
  status: IssueStatus;
  dependsOn: number[];
  /** Whether all deps are resolved. */
  depsResolved: boolean;
  /** Linked PR, if any. */
  pr: PRState | null;
  /** Agent working this issue, if any. */
  agent: AgentState | null;
  /** Overmind-provided spec summary. */
  specSummary: string | null;
  /** Whether Overmind has evaluated this issue. */
  evaluated: boolean;
  /** Overmind evaluation verdict. */
  evaluationVerdict: string | null;
}

// --- Phase state -------------------------------------------------------------

export interface PhaseState {
  name: string;
  status: PhaseStatus;
  /** Total issues in this phase. */
  issueCount: number;
  /** Issues by status. */
  issueDetails: IssueState[];
}

// --- App state ---------------------------------------------------------------

export interface AppState {
  name: string;
  /** Project directory name. */
  project: string;
  /** GitHub repo URL. */
  repo: string | null;
  /** Current active phase. */
  currentPhase: string | null;
  phases: PhaseState[];
  health: AppHealth;
  /** ISO 8601 timestamp of last activity across any agent for this app. */
  lastActivity: string | null;
}

// --- Attention ---------------------------------------------------------------

export interface AttentionAction {
  label: string;
  /** API route to call, e.g. "/api/sessions/foo/stop". */
  route: string;
  method: "POST" | "GET";
}

export interface AttentionItem {
  type: AttentionType;
  /** Issue or PR reference, e.g. "#42" or "PR #99". */
  target: string;
  summary: string;
  urgency: AttentionUrgency;
  actions: AttentionAction[];
  /** Additional context (session ID, error message, etc.). */
  context: Record<string, unknown>;
}

// --- Overmind state ----------------------------------------------------------

export interface OvermindState {
  /** Overmind-provided attention items (semantic layer). */
  attentionItems: AttentionItem[];
  /** Overmind reasoning log. */
  reasoning: string | null;
  /** When the Overmind last processed state. */
  processedAt: string | null; // ISO 8601
  /** Overmind processing cycle count. */
  cycleCount: number;
  /** Default actions the Overmind recommends. */
  defaultActions: DefaultAction[];
}

export interface DefaultAction {
  target: string;
  action: string;
  reason: string;
}

// --- Automation config -------------------------------------------------------

export interface AppAutomationConfig {
  autoFixCI: "on" | "off" | "ask";          // default: "on"
  autoResolveConflicts: "on" | "off";        // default: "on"
  autoAddressFeedback: "on" | "off";         // default: "off"
  autoMerge: "on" | "off";                   // default: "off"
  overrideWindowMs: number;                  // default: 10000
}

// --- Capacity ----------------------------------------------------------------

export interface Capacity {
  maxConcurrent: number;
  active: number;
  available: number;
}

// --- Root state --------------------------------------------------------------

export interface PortfolioState {
  /** Monotonically increasing revision for client-side change detection. */
  _rev: number;
  /** Schema version for forward compatibility. */
  version: 1;
  /** When this snapshot was computed. */
  timestamp: string; // ISO 8601
  /** Aggregate pulse across all apps. */
  pulse: Pulse;
  /** Session capacity. */
  capacity: Capacity;
  /** Per-app state, keyed by factory app name. */
  apps: AppState[];
  /** Sessions not associated with any factory app. */
  auxSessions: AgentState[];
  /** Mechanical attention items. */
  attention: AttentionItem[];
  /** Overmind semantic overlay (populated via write-back endpoint). */
  overmind: OvermindState;
  /** Per-app automation config. */
  automationConfig: Record<string, AppAutomationConfig>;
}

// --- Action types (for future dispatch) --------------------------------------

export type StateAction =
  | { type: "answer_question"; sessionKey: string; value: string }
  | { type: "stop_session"; sessionKey: string }
  | { type: "fix_ci"; project: string; prNumber: number }
  | { type: "resolve_conflicts"; project: string; prNumber: number }
  | { type: "merge_pr"; project: string; prNumber: number };

export interface ActionDispatch {
  action: StateAction;
  requestedAt: string; // ISO 8601
  requestedBy: string; // "overmind" | "human"
}
