import { InlineKeyboard } from "grammy";
import type { Question, CallbackAction } from "../types.js";

/**
 * Build an inline keyboard for AskUserQuestion responses.
 * Each option becomes a button, plus an "Other..." button for free text.
 *
 * Callback data format:
 * - Option: "ans:<taskId>:<qIdx>:<optIdx>"
 * - Other: "other:<taskId>:<qIdx>"
 */
export function buildQuestionKeyboard(
  taskId: string,
  questions: Question[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  questions.forEach((question, qIdx) => {
    question.options.forEach((option, optIdx) => {
      keyboard.text(option.label, `ans:${taskId}:${qIdx}:${optIdx}`).row();
    });
    keyboard.text("Other...", `other:${taskId}:${qIdx}`).row();
  });

  return keyboard;
}

/**
 * Parse callback data from button press into a CallbackAction.
 * Returns null if the format is invalid.
 */
export function parseCallback(data: string): CallbackAction | null {
  const parts = data.split(":");

  if (parts[0] === "ans" && parts.length === 4) {
    const questionIdx = parseInt(parts[2], 10);
    const optionIdx = parseInt(parts[3], 10);
    if (isNaN(questionIdx) || isNaN(optionIdx)) return null;
    return {
      type: "answer",
      taskId: parts[1],
      questionIdx,
      optionIdx,
    };
  }

  if (parts[0] === "other" && parts.length === 3) {
    const questionIdx = parseInt(parts[2], 10);
    if (isNaN(questionIdx)) return null;
    return {
      type: "other",
      taskId: parts[1],
      questionIdx,
    };
  }

  return null;
}

/**
 * Format the answer to send to Claude via tmux send-keys.
 * Claude Code expects a 1-based option index (e.g., "1", "2") or custom text.
 */
export function formatAnswer(
  action: CallbackAction,
  questions: Question[]
): string | null {
  const question = questions[action.questionIdx];
  if (!question) return null;

  if (action.type === "answer") {
    // Claude Code expects 1-based index
    return String(action.optionIdx + 1);
  }

  // "other" type - caller should prompt for free text
  return null;
}
