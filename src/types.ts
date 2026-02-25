// === Session State ===

/** Supported skill types for Miranda */
export type SkillType = "oh-task" | "oh-join" | "oh-merge" | "oh-notes" | "oh-plan" | "oh-review" | "oh-ci" | "oh-conflict" | "jira-plan";

/** UI request method type from oh-my-pi */
export type UIRequestMethod = "select" | "confirm" | "input";

export interface Session {
  taskId: string;
  /** Session identifier - process ID from agent process */
  sessionId: string;
  skill?: SkillType;
  status: "starting" | "running" | "waiting_input" | "stopped";
  startedAt: Date;
  /** Timestamp of last tool execution — used by Heimdall for stale detection */
  lastToolActivityAt?: Date;
  chatId: number; // Telegram chat for notifications
  /** Opaque label for session tracking (used by generic spawn, replaces skill as identifier) */
  label?: string;
  /** Path to the git worktree directory for this session (for cleanup) */
  worktreePath?: string;
  /** Path to the main project directory (for worktree cleanup commands) */
  projectPath?: string;
  pendingQuestion?: PendingQuestion;
  awaitingFreeText?: AwaitingFreeText;
  /** Pending UI request ID from agent (for extension_ui_response) */
  pendingUIRequestId?: string;
  /** Pending UI request method - needed to send correct response shape */
  pendingUIMethod?: UIRequestMethod;
  /** True if agent already signaled completion via signal_completion tool */
  signaled?: boolean;
}

export interface PendingQuestion {
  messageId: number; // Telegram message ID (for editing later)
  questions: Question[];
  receivedAt: Date;
}

export interface AwaitingFreeText {
  questionIdx: number;
  promptMessageId: number;
}

// === AskUserQuestion Types (from oh-my-pi extension_ui) ===

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionOption {
  label: string;
  description: string;
}

// === Callback Actions ===

// Callback data: "ans:<taskId>:<qIdx>:<optIdx>" or "other:<taskId>:<qIdx>"

export type CallbackAction =
  | { type: "answer"; taskId: string; questionIdx: number; optionIdx: number }
  | { type: "other"; taskId: string; questionIdx: number };
