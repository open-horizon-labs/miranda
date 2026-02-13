import { Bot } from "grammy";
import { buildQuestionKeyboard } from "../bot/keyboards.js";
import {
  getSession,
  setSession,
  deleteSession,
  findSessionBySessionId,
} from "../state/sessions.js";
import type {
  RpcEvent,
  RpcExtensionUIRequest,
  AgentProcess,
} from "./process.js";
import type { Question } from "../types.js";

// Bot reference for sending Telegram messages
// Set during startup by calling setBot()
let botInstance: Bot | null = null;

/**
 * Set the bot instance for event handling.
 * Must be called during startup before any agents are spawned.
 */
export function setBot(bot: Bot): void {
  botInstance = bot;
}

/**
 * Handle RPC events from an agent process.
 * This is the main entry point for processing agent stdout.
 */
export function handleAgentEvent(agent: AgentProcess, event: RpcEvent): void {
  const sessionId = agent.sessionId;

  switch (event.type) {
    case "extension_ui_request":
      handleExtensionUI(sessionId, event);
      break;

    case "agent_end":
      handleAgentEnd(sessionId);
      break;

    case "extension_error":
      console.error(`[agent:${sessionId}] Extension error:`, event.error);
      break;

    // Log other events for debugging
    case "response":
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_end":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      // Verbose event logging (could be gated by a debug flag)
      // console.debug(`[agent:${sessionId}] ${event.type}`);
      break;

    default:
      console.warn(`[agent:${sessionId}] Unknown event type:`, (event as { type: string }).type);
  }
}

/**
 * Handle agent process exit.
 * Clean up session state if process exits unexpectedly.
 */
export function handleAgentExit(sessionId: string, code: number | null, signal: string | null): void {
  const session = findSessionBySessionId(sessionId);
  if (!session) {
    console.log(`[agent:${sessionId}] Process exited (untracked)`);
    return;
  }

  // If the session was still running (not already cleaned up), treat as unexpected exit
  if (session.status === "running" || session.status === "waiting_input") {
    console.warn(`[agent:${sessionId}] Process exited unexpectedly (code=${code}, signal=${signal})`);

    // Send notification to user
    if (botInstance) {
      botInstance.api
        .sendMessage(
          session.chatId,
          `*${session.taskId}* exited unexpectedly (${signal ?? `code ${code}`})`,
          { parse_mode: "Markdown" }
        )
        .catch((err) => {
          console.error("Failed to send exit notification:", err);
        });
    }

    // Clean up session
    deleteSession(session.taskId);
  }
}

/**
 * Handle extension_ui event - agent is requesting user input.
 */
function handleExtensionUI(sessionId: string, event: RpcExtensionUIRequest): void {
  const session = findSessionBySessionId(sessionId);
  if (!session) {
    console.warn(`[agent:${sessionId}] extension_ui for unknown session`);
    return;
  }

  if (!botInstance) {
    console.error(`[agent:${sessionId}] Bot not initialized, cannot send notification`);
    return;
  }

  // Handle different UI methods
  // Note: oh-my-pi sends fields at top level, not nested in params
  switch (event.method) {
    case "select": {
      // Select is the equivalent of AskUserQuestion
      handleSelectRequest(session.taskId, session.chatId, event.id, event);
      break;
    }

    case "confirm": {
      handleConfirmRequest(session.taskId, session.chatId, event.id, event);
      break;
    }

    case "input": {
      handleInputRequest(session.taskId, session.chatId, event.id, event);
      break;
    }

    case "notify": {
      // Notification - just show a message, no response needed
      handleNotifyRequest(session.chatId, event);
      break;
    }

    case "editor":
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
      // These are IDE-specific methods, ignore in Telegram context
      console.debug(`[agent:${sessionId}] Ignoring UI method: ${event.method}`);
      break;

    default:
      console.warn(`[agent:${sessionId}] Unknown extension_ui method: ${event.method}`);
  }
}

/**
 * Handle agent_end event - agent has finished.
 */
function handleAgentEnd(sessionId: string): void {
  const session = findSessionBySessionId(sessionId);
  if (!session) {
    console.log(`[agent:${sessionId}] agent_end for untracked session`);
    return;
  }

  // The agent completed - send success notification
  if (botInstance) {
    botInstance.api
      .sendMessage(session.chatId, `*${session.taskId}* completed`, {
        parse_mode: "Markdown",
      })
      .catch((err) => {
        console.error("Failed to send completion notification:", err);
      });
  }

  // Clean up session
  deleteSession(session.taskId);
}

// ============================================================================
// UI Method Handlers
// ============================================================================

// Note: oh-my-pi sends all fields at top level in RpcExtensionUIRequest
// No separate param interfaces needed - we use the event directly

/**
 * Handle a select (multi-choice) request.
 * Converts to the same format as AskUserQuestion.
 */
function handleSelectRequest(
  taskId: string,
  chatId: number,
  requestId: string,
  event: RpcExtensionUIRequest
): void {
  const session = getSession(taskId);
  if (!session) return;

  // Convert to Question format used by buildQuestionKeyboard
  // oh-my-pi sends options as string[] at top level
  const questions: Question[] = [
    {
      question: event.placeholder ?? "Select an option:",
      header: event.title ?? "Input Required",
      options: (event.options ?? []).map((opt) => ({
        label: opt,
        description: "",
      })),
      multiSelect: false,
    },
  ];

  // Update session state
  session.status = "waiting_input";
  session.pendingQuestion = {
    messageId: 0,
    questions,
    receivedAt: new Date(),
  };
  session.pendingUIRequestId = requestId;
  session.pendingUIMethod = "select";
  setSession(taskId, session);

  // Build Telegram message
  const questionText = questions
    .map((q) => `*${q.header}*\n${q.question}`)
    .join("\n\n");

  const keyboard = buildQuestionKeyboard(taskId, questions);

  botInstance!.api
    .sendMessage(chatId, `*${taskId}* needs input:\n\n${questionText}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    })
    .then((msg) => {
      session.pendingQuestion!.messageId = msg.message_id;
      setSession(taskId, session);
    })
    .catch((err) => {
      console.error("Failed to send select notification:", err);
    });
}

/**
 * Handle a confirm (yes/no) request.
 */
function handleConfirmRequest(
  taskId: string,
  chatId: number,
  requestId: string,
  event: RpcExtensionUIRequest
): void {
  const session = getSession(taskId);
  if (!session) return;

  // Convert to Question format with yes/no options
  // NOTE: Button order matters! The callback handler in index.ts assumes
  // optionIdx 0 = confirm, optionIdx 1 = cancel. Keep this order.
  const questions: Question[] = [
    {
      question: event.message ?? "Please confirm",
      header: event.title ?? "Confirmation",
      options: [
        { label: event.confirmText ?? "Yes", description: "Confirm" },
        { label: event.cancelText ?? "No", description: "Cancel" },
      ],
      multiSelect: false,
    },
  ];

  // Update session state
  session.status = "waiting_input";
  session.pendingQuestion = {
    messageId: 0,
    questions,
    receivedAt: new Date(),
  };
  session.pendingUIRequestId = requestId;
  session.pendingUIMethod = "confirm";
  setSession(taskId, session);

  // Build Telegram message
  const keyboard = buildQuestionKeyboard(taskId, questions);

  botInstance!.api
    .sendMessage(chatId, `*${taskId}* needs confirmation:\n\n*${event.title ?? "Confirm"}*\n${event.message ?? ""}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    })
    .then((msg) => {
      session.pendingQuestion!.messageId = msg.message_id;
      setSession(taskId, session);
    })
    .catch((err) => {
      console.error("Failed to send confirm notification:", err);
    });
}

/**
 * Handle an input (free text) request.
 */
function handleInputRequest(
  taskId: string,
  chatId: number,
  requestId: string,
  event: RpcExtensionUIRequest
): void {
  const session = getSession(taskId);
  if (!session) return;

  // Update session to await free text
  session.status = "waiting_input";
  session.awaitingFreeText = {
    questionIdx: 0,
    promptMessageId: 0,
  };
  session.pendingUIRequestId = requestId;
  session.pendingUIMethod = "input";
  setSession(taskId, session);

  // Build message
  const title = event.title ?? "Input Required";
  const message = event.message ?? event.placeholder ?? "Enter your response:";
  const defaultHint = event.defaultValue ? `\n\n_Default: ${event.defaultValue}_` : "";

  botInstance!.api
    .sendMessage(chatId, `*${taskId}* needs input:\n\n*${title}*\n${message}${defaultHint}`, {
      parse_mode: "Markdown",
    })
    .then((msg) => {
      session.awaitingFreeText!.promptMessageId = msg.message_id;
      setSession(taskId, session);
    })
    .catch((err) => {
      console.error("Failed to send input notification:", err);
    });
}

/**
 * Handle a notification (info/warning/error message).
 * Uses notifyType field from oh-my-pi, falls back to info.
 */
function handleNotifyRequest(chatId: number, event: RpcExtensionUIRequest): void {
  const title = event.title ?? "Info";
  const notifyType = event.notifyType ?? "info";
  const emoji = notifyType === "error" ? "❌" : notifyType === "warning" ? "⚠️" : "ℹ️";

  botInstance!.api
    .sendMessage(chatId, `${emoji} *${title}*\n\n${event.message ?? ""}`, {
      parse_mode: "Markdown",
    })
    .catch((err) => {
      console.error("Failed to send notify message:", err);
    });
}
