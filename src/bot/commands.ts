import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  spawnSession,
  killSession,
  getTmuxName,
  listTmuxSessions,
  sendKeys,
} from "../tmux/sessions.js";
import {
  getSession,
  setSession,
  deleteSession,
  getAllSessions,
} from "../state/sessions.js";
import { scanProjects } from "../projects/scanner.js";
import type { Session } from "../types.js";

/**
 * Register command handlers on the bot instance.
 *
 * Commands implemented:
 * - /start - Welcome message
 * - /projects - List projects with task counts
 * - /mouse <task-id> - Spawn a mouse session
 * - /status - List all sessions
 * - /stop <session> - Kill a session (task-id or full session name)
 * - /drummer - Run batch merge
 * - /notes <pr-number> - Address PR feedback
 * - /logs, /ssh - Stubs for future implementation
 */
export function registerCommands(bot: Bot<Context>): void {
  bot.command("start", handleStart);
  bot.command("projects", handleProjects);
  bot.command("mouse", handleMouse);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("drummer", handleDrummer);
  bot.command("notes", handleNotes);
  bot.command("logs", handleLogs);
  bot.command("ssh", handleSsh);

  // Free text handler for "Other..." responses
  bot.on("message:text", handleFreeText);
}

async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    `*Miranda* - Remote Claude Orchestration

I give voice to the Primer. Commands:

/projects - List projects with tasks
/mouse <task-id> - Start a mouse on a task
/drummer - Run batch merge
/notes <pr-number> - Address PR feedback
/status - Show active sessions
/stop <session> - Stop a session
/logs <task-id> - View session logs
/ssh - Get SSH command

_From The Diamond Age by Neal Stephenson_`,
    { parse_mode: "Markdown" }
  );
}

async function handleProjects(ctx: Context): Promise<void> {
  const projects = await scanProjects();

  if (projects.length === 0) {
    await ctx.reply("*Projects*\n\n_No projects found with ba tasks_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Build message with task counts
  const lines: string[] = ["*Projects*", ""];
  for (const project of projects) {
    const counts: string[] = [];
    if (project.openCount > 0) {
      counts.push(`${project.openCount} open`);
    }
    if (project.inProgressCount > 0) {
      counts.push(`${project.inProgressCount} in progress`);
    }
    const countStr = counts.length > 0 ? ` (${counts.join(", ")})` : "";
    lines.push(`*${project.name}*${countStr}`);
  }

  // Build inline keyboard with buttons for each project
  // Note: Telegram callback data has 64-byte limit, truncate long names
  const keyboard = new InlineKeyboard();
  for (const project of projects) {
    const callbackName = project.name.slice(0, 50);
    keyboard.text(project.name, `tasks:${callbackName}`).row();
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

async function handleMouse(ctx: Context): Promise<void> {
  const taskId = ctx.match?.toString().trim();
  if (!taskId) {
    await ctx.reply("Usage: /mouse <task-id>");
    return;
  }

  // Check if session already exists
  const existing = getSession(taskId);
  if (existing) {
    await ctx.reply(`Session for ${taskId} already exists (${existing.status})`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  await ctx.reply(`Starting mouse for \`${taskId}\`...`, { parse_mode: "Markdown" });

  try {
    const tmuxName = await spawnSession("mouse", taskId, chatId);

    const session: Session = {
      taskId,
      tmuxName,
      skill: "mouse",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(taskId, session);

    await ctx.reply(
      `Mouse running for \`${taskId}\`
Branch: \`ba/${taskId}\`
Session: \`${tmuxName}\``,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start mouse: ${message}`);
  }
}

async function handleStatus(ctx: Context): Promise<void> {
  const sessions = getAllSessions();
  const tmuxSessions = await listTmuxSessions();

  if (sessions.length === 0 && tmuxSessions.length === 0) {
    await ctx.reply("*Remote Claude Status*\n\n_No active sessions_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Build status message
  const lines: string[] = ["*Remote Claude Status*", ""];

  // Running sessions
  const running = sessions.filter((s) => s.status === "running");
  if (running.length > 0) {
    lines.push("*Running:*");
    for (const s of running) {
      const elapsed = formatElapsed(s.startedAt);
      lines.push(`  \`${s.taskId}\` (${elapsed})`);
    }
    lines.push("");
  }

  // Waiting for input
  const waiting = sessions.filter((s) => s.status === "waiting_input");
  if (waiting.length > 0) {
    lines.push("*Needs input:*");
    for (const s of waiting) {
      lines.push(`  \`${s.taskId}\``);
    }
    lines.push("");
  }

  // Orphaned tmux sessions (in tmux but not in state)
  const trackedNames = new Set(sessions.map((s) => s.tmuxName));
  const orphaned = tmuxSessions.filter((t) => !trackedNames.has(t.name));
  if (orphaned.length > 0) {
    lines.push("*Orphaned (in tmux):*");
    for (const t of orphaned) {
      lines.push(`  \`${t.name}\``);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function handleStop(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim();
  if (!input) {
    await ctx.reply("Usage: /stop <task-id or session-name>");
    return;
  }

  // Check if input is a fully qualified session name (mouse-*, drummer-*, notes-*)
  // or a bare task ID that needs the mouse- prefix
  const isFullyQualified =
    input.startsWith("mouse-") ||
    input.startsWith("drummer-") ||
    input.startsWith("notes-");

  // Try to find session by input (works for both task IDs and tmux names)
  const session = getSession(input);
  let tmuxName: string;

  if (session) {
    // Found in state - use its tmux name
    tmuxName = session.tmuxName;
  } else if (isFullyQualified) {
    // Fully qualified name not in state - use directly
    tmuxName = input;
  } else {
    // Bare task ID - construct mouse session name
    tmuxName = getTmuxName(input);
  }

  try {
    await killSession(tmuxName);

    if (session) {
      deleteSession(input);
      await ctx.reply(`Stopped session \`${input}\``, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(`Killed tmux session \`${tmuxName}\` (was not tracked)`, {
        parse_mode: "Markdown",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to stop: ${message}`);
  }
}

async function handleDrummer(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  // Check if a drummer session is already running
  const sessions = getAllSessions();
  const existingDrummer = sessions.find(
    (s) => s.skill === "drummer" && s.status === "running"
  );
  if (existingDrummer) {
    await ctx.reply(
      `Drummer session already running: \`${existingDrummer.tmuxName}\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply("Starting drummer batch review...");

  try {
    const tmuxName = await spawnSession("drummer", undefined, chatId);

    // Use tmuxName as the session key since drummer has no task ID
    const session: Session = {
      taskId: tmuxName, // Use tmux name as identifier for drummer
      tmuxName,
      skill: "drummer",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(tmuxName, session);

    await ctx.reply(
      `Drummer running
Session: \`${tmuxName}\`

Reviewing PRs with \`drummer-merge\` label...`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start drummer: ${message}`);
  }
}

async function handleNotes(ctx: Context): Promise<void> {
  const prNumber = ctx.match?.toString().trim();
  if (!prNumber) {
    await ctx.reply("Usage: /notes <pr-number>");
    return;
  }

  // Validate PR number is numeric
  if (!/^\d+$/.test(prNumber)) {
    await ctx.reply("Error: PR number must be numeric (e.g., /notes 42)");
    return;
  }

  // Use PR number as session key
  const sessionKey = `notes-${prNumber}`;
  const existing = getSession(sessionKey);
  if (existing) {
    await ctx.reply(`Notes session for PR #${prNumber} already exists (${existing.status})`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  await ctx.reply(`Starting notes for PR #${prNumber}...`, { parse_mode: "Markdown" });

  try {
    const tmuxName = await spawnSession("notes", prNumber, chatId);

    const session: Session = {
      taskId: sessionKey,
      tmuxName,
      skill: "notes",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionKey, session);

    await ctx.reply(
      `Notes running for PR #${prNumber}
Session: \`${tmuxName}\`

Addressing human feedback...`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start notes: ${message}`);
  }
}

async function handleLogs(ctx: Context): Promise<void> {
  const taskId = ctx.match?.toString().trim();
  if (!taskId) {
    await ctx.reply("Usage: /logs <task-id>");
    return;
  }

  // TODO: Implement log viewing (Phase 4)
  await ctx.reply(`Logs for \`${taskId}\`...\n\n_Not yet implemented_`, {
    parse_mode: "Markdown",
  });
}

async function handleSsh(ctx: Context): Promise<void> {
  await ctx.reply(
    `\`\`\`
ssh hetzner
tmux attach
\`\`\``,
    { parse_mode: "Markdown" }
  );
}

/**
 * Handle free text input when user selects "Other..." on a question.
 * The session must have awaitingFreeText set and match the current chat.
 */
async function handleFreeText(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  const chatId = ctx.chat?.id;
  if (!text || !chatId) return;

  // Find session awaiting free text input for THIS chat
  // This prevents race conditions when multiple sessions are active
  const sessions = getAllSessions();
  const session = sessions.find(
    (s) => s.awaitingFreeText !== undefined && s.chatId === chatId
  );

  if (!session) {
    // Not awaiting input from this chat - ignore
    return;
  }

  // Send the text to the tmux session
  try {
    await sendKeys(session.tmuxName, text);

    // Clear awaiting state and update status
    session.awaitingFreeText = undefined;
    session.status = "running";
    setSession(session.taskId, session);

    await ctx.reply(`Sent: "${text}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to send input: ${message}`);
  }
}

function formatElapsed(startedAt: Date): string {
  const elapsed = Date.now() - startedAt.getTime();
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
