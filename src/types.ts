// === Session State ===

/** Supported skill types for Miranda */
export type SkillType = "mouse" | "drummer" | "notes" | "oh-task" | "oh-merge" | "oh-notes" | "oh-plan";

/** UI request method type from oh-my-pi */
export type UIRequestMethod = "select" | "confirm" | "input";

export interface Session {
  taskId: string;
  /** Session identifier - either a process ID (for agent) or tmux session name (legacy) */
  sessionId: string;
  skill: SkillType;
  status: "starting" | "running" | "waiting_input" | "stopped";
  startedAt: Date;
  chatId: number; // Telegram chat for notifications
  pendingQuestion?: PendingQuestion;
  awaitingFreeText?: AwaitingFreeText;
  /** Pending UI request ID from agent (for extension_ui_response) */
  pendingUIRequestId?: string;
  /** Pending UI request method - needed to send correct response shape */
  pendingUIMethod?: UIRequestMethod;
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

// === AskUserQuestion Types (from Claude / oh-my-pi extension_ui) ===

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

// === Hook Notification (Legacy - for tmux sessions using Claude Code hooks) ===

export interface HookNotification {
  session: string; // tmux session name
  tool: "AskUserQuestion";
  input: {
    questions: Question[];
  };
}

// === Callback Actions ===

// Callback data: "ans:<taskId>:<qIdx>:<optIdx>" or "other:<taskId>:<qIdx>"

export type CallbackAction =
  | { type: "answer"; taskId: string; questionIdx: number; optionIdx: number }
  | { type: "other"; taskId: string; questionIdx: number };

// === Completion Notification ===

export interface CompletionNotification {
  session: string; // Session ID
  status: "success" | "error" | "blocked";
  pr?: string; // PR URL on success
  error?: string; // Error message on failure
  blocker?: string; // Reason for blocked status
}

// === Alert Notification (from Shrike) ===

export interface AlertNotification {
  /** Alert type identifier */
  type: string;
  /** Alert title/headline */
  title: string;
  /** Main content/description */
  body?: string;
  /** URL to the source (e.g., post, article) */
  url?: string;
  /** Platform or source name */
  source?: string;
  /** Why this alert was triggered (e.g., keyword match) */
  reason?: string;
  /** Additional metadata as key-value pairs */
  metadata?: Record<string, string | number>;
}
