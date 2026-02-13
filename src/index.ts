import { Bot } from "grammy";
import { config, validateConfig } from "./config.js";
import { registerCommands, cleanupOrphanedSessions, handleTasksCallback, handleMouseCallback, discoverOrphanedSessions, executeKillall, handleResetCallback, stopSession } from "./bot/commands.js";
import { parseCallback } from "./bot/keyboards.js";
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
  getRestartChatId,
  clearRestartChatId,
} from "./state/sessions.js";

// Validate configuration
validateConfig();

// Create bot instance
const bot = new Bot(config.botToken);

// Set bot instance for event handling (allows agent events to send Telegram messages)
setBot(bot);

/**
 * Graceful shutdown function.
 * Stops the bot and all agent processes, then exits.
 * systemd/PM2 will restart Miranda automatically.
 */
export async function gracefulShutdown(): Promise<void> {
  console.log("Miranda shutting down...");

  try {
    // Stop bot polling first (prevents new commands)
    await bot.stop();
    console.log("   Bot stopped");

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

// Start bot
console.log("Miranda starting...");
console.log(`   Allowed users: ${config.allowedUserIds.join(", ") || "(none)"}`);

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
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
