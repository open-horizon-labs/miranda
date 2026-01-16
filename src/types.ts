// === Session State ===

/** Supported skill types for Miranda */
export type SkillType = "mouse" | "drummer" | "notes" | "oh-task" | "oh-merge";

export interface Session {
  taskId: string;
  tmuxName: string; // e.g., "mouse-kv-xxld"
  skill: SkillType;
  status: "starting" | "running" | "waiting_input" | "stopped";
  startedAt: Date;
  chatId: number; // Telegram chat for notifications
  pendingQuestion?: PendingQuestion;
  awaitingFreeText?: AwaitingFreeText;
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

// === AskUserQuestion Types (from Claude) ===

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

// === Hook Notification ===

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

// === tmux Commands ===

// Skill invocation: claude '<skill> [args]' --dangerously-skip-permissions
// e.g., "claude 'mouse kv-xxld' --dangerously-skip-permissions"
// e.g., "claude 'drummer' --dangerously-skip-permissions"

// === Completion Notification ===

export interface CompletionNotification {
  session: string; // tmux session name
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
