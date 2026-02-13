// === Session State ===

/** Supported skill types for Miranda */
export type SkillType = "mouse" | "drummer" | "notes" | "oh-task" | "oh-merge" | "oh-notes" | "oh-plan";

/** UI request method type from oh-my-pi */
export type UIRequestMethod = "select" | "confirm" | "input";

export interface Session {
  taskId: string;
  /** Session identifier - process ID from agent process */
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
