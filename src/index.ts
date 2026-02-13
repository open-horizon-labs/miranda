import { Bot } from "grammy";
import { config, validateConfig } from "./config.js";
import { registerCommands, cleanupOrphanedSessions, handleTasksCallback, handleMouseCallback, discoverOrphanedSessions, executeKillall, handleResetCallback, stopSession, killSession } from "./bot/commands.js";
import { parseCallback, buildQuestionKeyboard } from "./bot/keyboards.js";
import { createHookServer, type HookServer } from "./hooks/server.js";
import {
  getAgent,
  sendUIResponse,
  getAllAgents,
  killAgent,
} from "./agent/process.js";
import { setBot } from "./agent/events.js";
import {
  getSession,
  setSession,
  deleteSession,
  findSessionBySessionId,
  getRestartChatId,
  clearRestartChatId,
} from "./state/sessions.js";
import type { HookNotification, CompletionNotification, AlertNotification } from "./types.js";
import { escapeForCodeBlock, escapeMarkdown } from "./utils/telegram.js";

// Validate configuration
validateConfig();

// Create bot instance
const bot = new Bot(config.botToken);

// Set bot instance for event handling (allows agent events to send Telegram messages)
setBot(bot);

// Hook server (created later, stored here for shutdown access)
let hookServer: HookServer;

/**
 * Graceful shutdown function.
 * Stops the bot, hook server, and all agent processes, then exits.
 * systemd/PM2 will restart Miranda automatically.
 */
export async function gracefulShutdown(): Promise<void> {
  console.log("Miranda shutting down...");

  try {
    // Stop bot polling first (prevents new commands)
    await bot.stop();
    console.log("   Bot stopped");

    // Stop hook server (prevents new notifications)
    if (hookServer) {
      await hookServer.stop();
      console.log("   Hook server stopped");
    }

    // Kill all agent processes
    const agents = getAllAgents();
    if (agents.length > 0) {
      console.log(`   Killing ${agents.length} agent process(es)...`);
      await Promise.allSettled(agents.map((a) => killAgent(a, 1000)));
      console.log("   Agent processes killed");
    }

    console.log("Miranda shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
}

// Auth middleware - reject unauthorized users
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !config.allowedUserIds.includes(userId)) {
    console.log(`Rejected request from user ${userId}`);
    return;
  }
  await next();
});

// Register command handlers (pass shutdown function for /restart)
registerCommands(bot, gracefulShutdown);

// Callback query handler for inline keyboards
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat?.id;

  // Handle cleanup callbacks (not session-related)
  if (data === "cleanup:confirm") {
    try {
      const count = await cleanupOrphanedSessions();
      await ctx.answerCallbackQuery({ text: `Removed ${count} session(s)` });
      await ctx.editMessageText(`*Cleanup*\n\n_Removed ${count} orphaned session(s)_`, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: `Error: ${message}` });
      await ctx.editMessageText(`*Cleanup*\n\n_Error: ${message}_`, {
        parse_mode: "Markdown",
      }).catch(() => {}); // Best-effort update
    }
    return;
  }

  if (data === "cleanup:cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("*Cleanup*\n\n_Cancelled_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Handle killall callbacks
  if (data === "killall:confirm") {
    try {
      const { killed, errors } = await executeKillall();
      const errorMsg = errors.length > 0
        ? `\n\n_Errors: ${errors.join(", ")}_`
        : "";
      await ctx.answerCallbackQuery({ text: `Killed ${killed} session(s)` });
      await ctx.editMessageText(`*Kill All*\n\n_Killed ${killed} session(s)_${errorMsg}`, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: `Error: ${message}` });
      await ctx.editMessageText(`*Kill All*\n\n_Error: ${message}_`, {
        parse_mode: "Markdown",
      }).catch(() => {}); // Best-effort update
    }
    return;
  }

  if (data === "killall:cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("*Kill All*\n\n_Cancelled_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Handle reset:confirm:<project> and reset:cancel:<project> callbacks
  if (data.startsWith("reset:confirm:") || data.startsWith("reset:cancel:")) {
    const parts = data.split(":");
    const confirmed = parts[1] === "confirm";
    const projectName = parts.slice(2).join(":"); // Rejoin in case project name has colons
    await ctx.answerCallbackQuery({ text: confirmed ? "Resetting..." : "Cancelled" });
    await handleResetCallback(
      projectName,
      confirmed,
      async (text, options) => {
        await ctx.editMessageText(text, options);
      }
    );
    return;
  }

  // Handle tasks:<project> callback from /projects
  if (data.startsWith("tasks:")) {
    const projectName = data.slice(6); // Remove "tasks:" prefix
    await ctx.answerCallbackQuery();
    await handleTasksCallback(
      projectName,
      async (text, options) => {
        await ctx.reply(text, options);
      }
    );
    return;
  }

  // Handle mouse:<task-id> callback from /tasks
  if (data.startsWith("mouse:")) {
    const taskId = data.slice(6); // Remove "mouse:" prefix
    await ctx.answerCallbackQuery({ text: `Starting mouse for ${taskId}...` });
    if (!chatId) {
      return;
    }
    await handleMouseCallback(
      taskId,
      chatId,
      async (text, options) => {
        await ctx.reply(text, options);
      }
    );
    return;
  }

  // Handle stop:<taskId> callback from session start messages and /status
  if (data.startsWith("stop:")) {
    const sessionKey = data.slice(5); // Remove "stop:" prefix
    const session = getSession(sessionKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Session not found" });
      return;
    }

    try {
      // Use graceful stop with fallback to kill
      const graceful = await stopSession(session.sessionId);
      deleteSession(sessionKey);
      const method = graceful ? "stopped" : "killed";
      await ctx.answerCallbackQuery({ text: `Session ${method}` });
      await ctx.editMessageText(`Session \`${sessionKey}\` ${method}`, {
        parse_mode: "Markdown",
      }).catch(() => {}); // Best-effort update
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: `Error: ${message}` });
    }
    return;
  }

  // Handle question/answer callbacks
  const action = parseCallback(data);

  if (!action) {
    await ctx.answerCallbackQuery({ text: "Invalid action" });
    return;
  }

  const session = getSession(action.taskId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found" });
    return;
  }

  if (!session.pendingQuestion) {
    await ctx.answerCallbackQuery({ text: "No pending question" });
    return;
  }

  const questions = session.pendingQuestion.questions;

  if (action.type === "answer") {
    // Send the selected option via RPC
    const question = questions[action.questionIdx];
    const selectedOption = question?.options[action.optionIdx];
    if (selectedOption) {
      try {
        const agent = getAgent(session.sessionId);
        if (agent && session.pendingUIRequestId) {
          // Build correct response shape based on UI method
          const method = session.pendingUIMethod;
          if (method === "confirm") {
            // For confirm: send { confirmed: true/false }
            // optionIdx === 0 means first button was pressed.
            // handleConfirmRequest (events.ts) builds options as [confirmText, cancelText],
            // so first button = confirm, second button = cancel.
            const confirmed = action.optionIdx === 0;
            sendUIResponse(agent, session.pendingUIRequestId, { confirmed });
          } else {
            // For select (and others): send { value: "selected option string" }
            sendUIResponse(agent, session.pendingUIRequestId, { value: selectedOption.label });
          }
        }
        session.pendingQuestion = undefined;
        session.pendingUIRequestId = undefined;
        session.pendingUIMethod = undefined;
        session.status = "running";
        setSession(session.taskId, session);
        await ctx.answerCallbackQuery({ text: "Response sent!" });
        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text}\n\n_Answered: ${selectedOption.label}_`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.answerCallbackQuery({ text: `Error: ${message}` });
      }
    }
  } else if (action.type === "other") {
    // Prompt for free text input
    session.awaitingFreeText = {
      questionIdx: action.questionIdx,
      promptMessageId: ctx.callbackQuery.message?.message_id ?? 0,
    };
    setSession(session.taskId, session);
    await ctx.answerCallbackQuery();
    await ctx.reply("Type your response:");
  }
});

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Hook notification handler (legacy - for tmux sessions using Claude Code hooks)
// NOTE: This handler won't match agent-based sessions since they use process IDs
// as sessionId, not tmux session names. This is expected - the hook server is
// transitional and will be removed entirely once agent sessions use RPC events
// exclusively (tracked in #68).
function handleNotification(notification: HookNotification): void {
  const session = findSessionBySessionId(notification.session);
  if (!session) {
    console.warn(`Notification for unknown session: ${notification.session}`);
    return;
  }

  // Update session state
  session.status = "waiting_input";
  session.pendingQuestion = {
    messageId: 0, // Will be set after sending
    questions: notification.input.questions,
    receivedAt: new Date(),
  };
  setSession(session.taskId, session);

  // Send notification to Telegram
  const questions = notification.input.questions;
  const questionText = questions
    .map((q, i) => `*${q.header}*\n${q.question}`)
    .join("\n\n");

  const keyboard = buildQuestionKeyboard(session.taskId, questions);

  bot.api
    .sendMessage(session.chatId, `*${session.taskId}* needs input:\n\n${questionText}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    })
    .then((msg) => {
      // Update with actual message ID
      session.pendingQuestion!.messageId = msg.message_id;
      setSession(session.taskId, session);
    })
    .catch((err) => {
      console.error("Failed to send notification:", err);
    });
}

// Completion handler - called when skill finishes (via signal_completion tool)
// NOTE: Like handleNotification, this only works with tmux session names.
// Agent-based sessions signal completion via agent_end RPC event instead.
// This handler will be removed with #68.
function handleCompletion(completion: CompletionNotification): void {
  const session = findSessionBySessionId(completion.session);
  if (!session) {
    console.warn(`Completion for unknown session: ${completion.session}`);
    return;
  }

  const taskId = session.taskId;
  const chatId = session.chatId;
  const sessionId = session.sessionId;

  // Remove session from tracking immediately - the skill is done regardless of
  // whether we successfully notify the user. Telegram delivery is best-effort.
  deleteSession(taskId);

  // Kill the agent process - the skill has signaled completion
  killSession(sessionId).catch((err) => {
    console.error(`Failed to kill agent session ${sessionId}:`, err);
  });

  // Send notification to Telegram
  if (completion.status === "success") {
    // Escape parentheses in URL to prevent breaking Markdown link syntax
    const escapedPr = completion.pr?.replace(/\(/g, "%28").replace(/\)/g, "%29");
    const prLink = escapedPr ? `\n\n[View PR](${escapedPr})` : "";
    bot.api
      .sendMessage(chatId, `*${taskId}* completed successfully${prLink}`, {
        parse_mode: "Markdown",
      })
      .catch((err) => {
        console.error("Failed to send completion notification:", err);
      });
  } else if (completion.status === "blocked") {
    const blockerMsg = completion.blocker
      ? `\n\n\`${escapeForCodeBlock(completion.blocker)}\``
      : "";
    bot.api
      .sendMessage(chatId, `*${taskId}* blocked - needs human decision${blockerMsg}`, {
        parse_mode: "Markdown",
      })
      .catch((err) => {
        console.error("Failed to send blocked notification:", err);
      });
  } else {
    const errorMsg = completion.error
      ? `\n\n\`${escapeForCodeBlock(completion.error)}\``
      : "";
    bot.api
      .sendMessage(chatId, `*${taskId}* failed${errorMsg}`, {
        parse_mode: "Markdown",
      })
      .catch((err) => {
        console.error("Failed to send error notification:", err);
      });
  }
}

// Alert handler - called when Shrike sends an alert
function handleAlert(alert: AlertNotification): void {
  // Format the alert message for Telegram
  const lines: string[] = [];

  // Header with type and source
  const sourceInfo = alert.source ? ` (${escapeMarkdown(alert.source)})` : "";
  lines.push(`*${escapeMarkdown(alert.type)}*${sourceInfo}`);

  // Title
  lines.push(escapeMarkdown(alert.title));

  // Body if present
  if (alert.body) {
    lines.push("");
    lines.push(escapeMarkdown(alert.body));
  }

  // Reason if present
  if (alert.reason) {
    lines.push("");
    lines.push(`_${escapeMarkdown(alert.reason)}_`);
  }

  // URL if present
  if (alert.url) {
    lines.push("");
    // Escape parentheses in URL to prevent breaking Markdown link syntax
    const escapedUrl = alert.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
    lines.push(`[View](${escapedUrl})`);
  }

  // Metadata if present
  if (alert.metadata && Object.keys(alert.metadata).length > 0) {
    lines.push("");
    for (const [key, value] of Object.entries(alert.metadata)) {
      lines.push(`${escapeMarkdown(key)}: ${escapeMarkdown(String(value))}`);
    }
  }

  const message = lines.join("\n");

  // Send to all allowed users
  for (const userId of config.allowedUserIds) {
    bot.api
      .sendMessage(userId, message, { parse_mode: "Markdown" })
      .catch((err) => {
        console.error(`Failed to send alert to user ${userId}:`, err);
      });
  }
}

// Start hook server
hookServer = createHookServer(config.hookPort, handleNotification, handleCompletion, handleAlert);

// Start bot and hook server
console.log("Miranda starting...");
console.log(`   Allowed users: ${config.allowedUserIds.join(", ") || "(none)"}`);
console.log(`   Hook port: ${config.hookPort}`);

Promise.all([
  hookServer.start(),
  bot.start({
    onStart: async (info) => {
      console.log(`   Bot: @${info.username}`);

      // Discover orphaned sessions (no-op for agent-based sessions)
      const orphanCount = await discoverOrphanedSessions();
      if (orphanCount > 0) {
        console.log(`   Discovered ${orphanCount} orphaned session(s)`);
      }

      // Send "back online" message if we have a restart chat ID
      const restartChatId = getRestartChatId();
      if (restartChatId) {
        clearRestartChatId();
        bot.api.sendMessage(restartChatId, `*Miranda is back online*`, {
          parse_mode: "Markdown",
        }).catch((err) => {
          console.error("Failed to send back online message:", err);
        });
      }

      console.log("Miranda is ready");
    },
  }),
]).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
