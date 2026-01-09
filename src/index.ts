import { Bot } from "grammy";
import { config, validateConfig } from "./config.js";
import { registerCommands, cleanupOrphanedSessions, handleTasksCallback, handleMouseCallback, discoverOrphanedSessions, executeKillall, handleResetCallback } from "./bot/commands.js";
import { parseCallback, formatAnswer, buildQuestionKeyboard } from "./bot/keyboards.js";
import { createHookServer, type HookServer } from "./hooks/server.js";
import { sendKeys, killSession, stopSession } from "./tmux/sessions.js";
import {
  getSession,
  setSession,
  deleteSession,
  findSessionByTmuxName,
  getRestartChatId,
  clearRestartChatId,
} from "./state/sessions.js";
import type { HookNotification, CompletionNotification } from "./types.js";
import { escapeForCodeBlock } from "./utils/telegram.js";

// Validate configuration
validateConfig();

// Create bot instance
const bot = new Bot(config.botToken);

// Hook server (created later, stored here for shutdown access)
let hookServer: HookServer;

/**
 * Graceful shutdown function.
 * Stops the bot and hook server, then exits the process.
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
      const graceful = await stopSession(session.tmuxName);
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
    // Send the selected option to tmux
    const answer = formatAnswer(action, questions);
    if (answer) {
      try {
        await sendKeys(session.tmuxName, answer);
        session.pendingQuestion = undefined;
        session.status = "running";
        setSession(session.taskId, session);
        await ctx.answerCallbackQuery({ text: "Response sent!" });
        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text}\n\n_Answered: ${questions[action.questionIdx]?.options[action.optionIdx]?.label}_`,
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

// Hook notification handler
function handleNotification(notification: HookNotification): void {
  const session = findSessionByTmuxName(notification.session);
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

// Completion handler - called when skill finishes
function handleCompletion(completion: CompletionNotification): void {
  const session = findSessionByTmuxName(completion.session);
  if (!session) {
    console.warn(`Completion for unknown session: ${completion.session}`);
    return;
  }

  const taskId = session.taskId;
  const chatId = session.chatId;
  const tmuxName = session.tmuxName;

  // Remove session from tracking immediately - the skill is done regardless of
  // whether we successfully notify the user. Telegram delivery is best-effort.
  deleteSession(taskId);

  // Kill the tmux session - the skill has signaled completion, no need to keep it alive
  killSession(tmuxName).catch((err) => {
    console.error(`Failed to kill tmux session ${tmuxName}:`, err);
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

// Start hook server
hookServer = createHookServer(config.hookPort, handleNotification, handleCompletion);

// Start bot and hook server
console.log("Miranda starting...");
console.log(`   Allowed users: ${config.allowedUserIds.join(", ") || "(none)"}`);
console.log(`   Hook port: ${config.hookPort}`);

Promise.all([
  hookServer.start(),
  bot.start({
    onStart: async (info) => {
      console.log(`   Bot: @${info.username}`);

      // Discover orphaned tmux sessions and repopulate state
      const orphanCount = await discoverOrphanedSessions();
      if (orphanCount > 0) {
        console.log(`   Discovered ${orphanCount} orphaned session(s)`);
      }

      // Send "back online" message if we have a restart chat ID
      const restartChatId = getRestartChatId();
      if (restartChatId) {
        clearRestartChatId();
        const orphanMsg = orphanCount > 0
          ? `\n\n_Discovered ${orphanCount} orphaned session(s) - run /status to see them_`
          : "";
        bot.api.sendMessage(restartChatId, `*Miranda is back online*${orphanMsg}`, {
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
