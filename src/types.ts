// === Session State ===

/** Supported skill types for Miranda */
export type SkillType = "mouse" | "drummer" | "notes";

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
