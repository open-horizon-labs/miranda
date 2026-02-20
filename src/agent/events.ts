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
  RpcToolEvent,
  RpcMessageEvent,
  AgentProcess,
} from "./process.js";
import type { Question } from "../types.js";
import { emitLogEvent, closeSession as closeLogSession } from "../api/logs.js";

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

  // Fan-out to SSE log subscribers
  emitLogEventForRpc(sessionId, event);

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

    case "tool_execution_end":
      handleToolExecutionEnd(sessionId, event);
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
    closeLogSession(sessionId);
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

  // Only send generic completion notification if we haven't already signaled.
  // If signal_completion was called, we already sent a rich notification.
  if (!session.signaled && botInstance) {
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
  closeLogSession(sessionId);
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

// ============================================================================
// Tool Event Handlers
// ============================================================================

/** Structured completion data from signal_completion tool */
interface SignalCompletionParams {
  status: "success" | "error" | "blocked";
  pr?: string;
  error?: string;
  blocker?: string;
}

/**
 * Handle tool_execution_end events.
 * Specifically watches for signal_completion tool calls to extract structured outcomes.
 */
function handleToolExecutionEnd(sessionId: string, event: RpcToolEvent): void {
  // Only handle signal_completion tool
  if (event.toolName !== "signal_completion") {
    return;
  }

  const session = findSessionBySessionId(sessionId);
  if (!session) {
    console.warn(`[agent:${sessionId}] signal_completion for unknown session`);
    return;
  }

  if (!botInstance) {
    console.error(`[agent:${sessionId}] Bot not initialized, cannot send notification`);
    return;
  }

  // Extract structured data from tool result
  // The signal_completion tool returns params in result.details
  const details = event.result?.details as SignalCompletionParams | undefined;
  if (!details || !details.status) {
    console.warn(`[agent:${sessionId}] signal_completion missing details:`, event.result);
    return;
  }

  const { status, pr, error, blocker } = details;

  // Build notification message based on status
  let message: string;
  switch (status) {
    case "success":
      message = pr
        ? `*${session.taskId}* completed\n\n[View PR](${pr})`
        : `*${session.taskId}* completed`;
      break;
    case "error":
      message = `*${session.taskId}* failed\n\n${error ?? "Unknown error"}`;
      break;
    case "blocked":
      message = `*${session.taskId}* blocked\n\n${blocker ?? "Needs human decision"}`;
      break;
    default:
      message = `*${session.taskId}* signaled: ${status}`;
  }

  // Mark session as signaled to prevent duplicate notification from agent_end
  session.signaled = true;
  setSession(session.taskId, session);

  // Send notification
  botInstance.api
    .sendMessage(session.chatId, message, { parse_mode: "Markdown" })
    .catch((err) => {
      console.error("Failed to send completion notification:", err);
    });

  // Note: We don't delete the session here - the agent_end event will handle cleanup.
  // This allows the agent to continue (e.g., cleanup worktrees) after signaling.
  console.log(`[agent:${sessionId}] signal_completion: status=${status}${pr ? ` pr=${pr}` : ""}${error ? ` error=${error}` : ""}${blocker ? ` blocker=${blocker}` : ""}`);
}

// ============================================================================
// SSE Log Event Fan-out
// ============================================================================

/**
 * Format current time as HH:MM:SS for log events.
 */
function logTimeNow(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

/**
 * Extract a short human-readable summary from tool input data.
 */
function summarizeToolInput(tool: string | undefined, data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const MAX = 120;
  const trunc = (s: string) => s.length > MAX ? s.slice(0, MAX) + "\u2026" : s;

  switch (tool) {
    case "Bash":
    case "bash":
      return typeof d.command === "string" ? trunc(d.command) : undefined;
    case "Read":
    case "read":
      return typeof d.path === "string" ? d.path : undefined;
    case "Write":
    case "write":
      return typeof d.path === "string" ? d.path : undefined;
    case "Edit":
    case "edit":
      return typeof d.path === "string" ? d.path : undefined;
    case "Grep":
    case "grep":
      return typeof d.pattern === "string" ? trunc(d.pattern) : undefined;
    case "Find":
    case "find":
      return typeof d.pattern === "string" ? trunc(d.pattern) : undefined;
    case "WebSearch":
    case "web_search":
      return typeof d.query === "string" ? trunc(d.query) : undefined;
    case "WebFetch":
    case "web_fetch":
      return typeof d.url === "string" ? trunc(d.url) : undefined;
    case "Task":
    case "task": {
      const tasks = d.tasks;
      if (Array.isArray(tasks)) return tasks.length + " subtask(s)";
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Map RPC events to LogEvent and emit to SSE subscribers.
 * Skips thinking_delta, toolcall_delta, and other noisy/irrelevant events.
 */
function emitLogEventForRpc(sessionId: string, event: RpcEvent): void {
  const time = logTimeNow();

  switch (event.type) {
    case "tool_execution_start": {
      const te = event as RpcToolEvent;
      const detail = summarizeToolInput(te.toolName, te.data);
      emitLogEvent(sessionId, { type: "tool_start", tool: te.toolName, content: detail, time });
      break;
    }

    case "tool_execution_end":
      emitLogEvent(sessionId, { type: "tool_end", tool: (event as RpcToolEvent).toolName, time });
      break;

    case "message_update": {
      const msg = event as RpcMessageEvent;
      if (msg.delta?.type === "text_delta" && msg.delta.content) {
        emitLogEvent(sessionId, { type: "text", content: msg.delta.content, time });
      }
      // Skip thinking_delta, toolcall_delta
      break;
    }

    case "extension_ui_request": {
      const ui = event as RpcExtensionUIRequest;
      emitLogEvent(sessionId, { type: "question", content: ui.title ?? ui.placeholder ?? "Input required", time });
      break;
    }

    case "agent_end":
      emitLogEvent(sessionId, { type: "complete", time });
      break;

    case "extension_error":
      emitLogEvent(sessionId, { type: "error", content: (event as { error: string }).error, time });
      break;

    // Skip: response, agent_start, turn_start/end, message_start/end, tool_execution_update
    default:
      break;
  }
}