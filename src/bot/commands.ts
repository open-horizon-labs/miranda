import { basename } from "path";
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  spawnSession,
  killSession,
  getTmuxName,
  listTmuxSessions,
  sendKeys,
  type TmuxSession,
  type SpawnOptions,
} from "../tmux/sessions.js";
import {
  getSession,
  setSession,
  deleteSession,
  getAllSessions,
} from "../state/sessions.js";
import { scanProjects, getProjectTasks, findProjectForTask, isRepoDirty, pullProject, updateProjectIfClean, selfUpdate, type TaskInfo, type UpdateResult, type SelfUpdateResult } from "../projects/scanner.js";
import { cloneAndInit } from "../projects/clone.js";
import { config } from "../config.js";
import type { Session } from "../types.js";

/** Parsed mouse command arguments */
interface MouseArgs {
  taskId: string;
  baseBranch?: string;
}

/**
 * Parse /mouse command arguments.
 * Format: /mouse <task-id> [--base <branch>]
 */
function parseMouseArgs(input: string): MouseArgs | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Match: taskId followed by optional --base <branch>
  const match = trimmed.match(/^(\S+)(?:\s+--base\s+(\S+))?$/);
  if (!match) return null;

  return {
    taskId: match[1],
    baseBranch: match[2],
  };
}

/**
 * Build inline keyboard with task buttons for a project.
 * Shared by handleTasks command and handleTasksCallback.
 */
export function buildTaskKeyboard(
  tasks: TaskInfo[],
  projectName: string
): { message: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  for (const task of tasks) {
    const statusEmoji = task.status === "in_progress" ? "🔄" : "📋";
    // Truncate title to fit in button (leaving room for ID)
    const maxTitleLen = 30;
    const displayTitle =
      task.title.length > maxTitleLen
        ? task.title.slice(0, maxTitleLen - 1) + "…"
        : task.title;
    keyboard.text(`${statusEmoji} ${task.id}: ${displayTitle}`, `mouse:${task.id}`).row();
  }

  return {
    message: `*Tasks for ${projectName}*`,
    keyboard,
  };
}

/**
 * Get orphaned tmux sessions (in tmux but not tracked in state).
 * Exported for use by callback handler.
 */
export async function getOrphanedSessions(): Promise<TmuxSession[]> {
  const sessions = getAllSessions();
  const tmuxSessions = await listTmuxSessions();
  const trackedNames = new Set(sessions.map((s) => s.tmuxName));
  return tmuxSessions.filter((t) => !trackedNames.has(t.name));
}

/**
 * Kill all orphaned tmux sessions.
 * Returns the count of sessions killed.
 */
export async function cleanupOrphanedSessions(): Promise<number> {
  const orphaned = await getOrphanedSessions();
  await Promise.allSettled(orphaned.map((t) => killSession(t.name)));
  return orphaned.length;
}

/**
 * Register command handlers on the bot instance.
 *
 * Commands implemented:
 * - /start - Welcome message
 * - /projects - List projects with task counts
 * - /tasks <project> - List tasks for a project with inline selection
 * - /mouse <task-id> - Spawn a mouse session
 * - /status - List all sessions
 * - /stop <session> - Kill a session (task-id or full session name)
 * - /cleanup - Remove orphaned tmux sessions
 * - /drummer <project> - Run batch merge for a project
 * - /notes <project> <pr-number> - Address PR feedback
 * - /newproject <repo> - Clone repo and init ba/sg/wm
 * - /update - Pull all clean projects
 * - /logs, /ssh - Stubs for future implementation
 */
export function registerCommands(bot: Bot<Context>): void {
  bot.command("start", handleStart);
  bot.command("projects", handleProjects);
  bot.command("tasks", handleTasks);
  bot.command("mouse", handleMouse);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("cleanup", handleCleanup);
  bot.command("drummer", handleDrummer);
  bot.command("notes", handleNotes);
  bot.command("newproject", handleNewProject);
  bot.command("update", handleUpdate);
  bot.command("selfupdate", handleSelfUpdate);
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
/tasks <project> - List tasks for a project
/newproject <repo> - Clone and init new project
/update - Pull all clean projects
/selfupdate - Pull and rebuild Miranda
/mouse <task-id> - Start a mouse on a task
/drummer <project> - Run batch merge for project
/notes <project> <pr> - Address PR feedback
/status - Show active sessions
/stop <session> - Stop a session
/cleanup - Remove orphaned sessions
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

async function handleTasks(ctx: Context): Promise<void> {
  const projectName = ctx.match?.toString().trim();
  if (!projectName) {
    await ctx.reply("Usage: /tasks <project-name>");
    return;
  }

  // Auto-update project before listing tasks (best-effort, don't block on failure)
  const projectPath = `${config.projectsDir}/${projectName}`;
  try {
    await updateProjectIfClean(projectPath);
  } catch {
    // Silently continue - update is best-effort
  }

  const tasks = await getProjectTasks(projectName);

  if (tasks.length === 0) {
    await ctx.reply(`*Tasks for ${projectName}*\n\n_No tasks ready_`, {
      parse_mode: "Markdown",
    });
    return;
  }

  const { message, keyboard } = buildTaskKeyboard(tasks, projectName);
  await ctx.reply(message, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * Handle tasks callback from /projects - external entry point for callback handler
 */
export async function handleTasksCallback(
  projectName: string,
  sendMessage: (text: string, options?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML"; reply_markup?: InlineKeyboard }) => Promise<void>
): Promise<void> {
  // Auto-update project before listing tasks (best-effort, don't block on failure)
  const projectPath = `${config.projectsDir}/${projectName}`;
  try {
    await updateProjectIfClean(projectPath);
  } catch {
    // Silently continue - update is best-effort
  }

  const tasks = await getProjectTasks(projectName);

  if (tasks.length === 0) {
    await sendMessage(`*Tasks for ${projectName}*\n\n_No tasks ready_`, {
      parse_mode: "Markdown",
    });
    return;
  }

  const { message, keyboard } = buildTaskKeyboard(tasks, projectName);
  await sendMessage(message, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * Handle mouse callback from /tasks - spawns mouse for selected task
 */
export async function handleMouseCallback(
  taskId: string,
  chatId: number,
  sendMessage: (text: string, options?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML" }) => Promise<void>
): Promise<void> {
  // Check if session already exists
  const existing = getSession(taskId);
  if (existing) {
    await sendMessage(`Session for ${taskId} already exists (${existing.status})`);
    return;
  }

  // Auto-discover project from task ID
  let projectPath = await findProjectForTask(taskId);
  if (!projectPath) {
    await sendMessage(`Task \`${taskId}\` not found in any project`, { parse_mode: "Markdown" });
    return;
  }

  // Auto-update project before starting mouse (best-effort, don't block on failure)
  try {
    await updateProjectIfClean(projectPath);
  } catch {
    // Silently continue - update is best-effort
  }

  // Re-check task exists after update (task list may have changed)
  projectPath = await findProjectForTask(taskId);
  if (!projectPath) {
    await sendMessage(`Task \`${taskId}\` no longer exists after update`, { parse_mode: "Markdown" });
    return;
  }

  const projectName = basename(projectPath) || "unknown";
  await sendMessage(`Starting mouse for \`${projectName}: ${taskId}\`...`, { parse_mode: "Markdown" });

  try {
    const tmuxName = await spawnSession("mouse", taskId, chatId, { projectPath });

    const session: Session = {
      taskId,
      tmuxName,
      skill: "mouse",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(taskId, session);

    await sendMessage(
      `Mouse running for \`${taskId}\`
Branch: \`ba/${taskId}\`
Session: \`${tmuxName}\``,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendMessage(`Failed to start mouse: ${message}`);
  }
}

async function handleMouse(ctx: Context): Promise<void> {
  const input = ctx.match?.toString() ?? "";
  const args = parseMouseArgs(input);
  if (!args) {
    await ctx.reply("Usage: /mouse <task-id> [--base <branch>]");
    return;
  }

  const { taskId, baseBranch } = args;

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

  // Auto-discover project from task ID
  let projectPath = await findProjectForTask(taskId);
  if (!projectPath) {
    await ctx.reply(`Task \`${taskId}\` not found in any project`, { parse_mode: "Markdown" });
    return;
  }

  // Auto-update project before starting mouse (best-effort, don't block on failure)
  try {
    await updateProjectIfClean(projectPath);
  } catch {
    // Silently continue - update is best-effort
  }

  // Re-check task exists after update (task list may have changed)
  projectPath = await findProjectForTask(taskId);
  if (!projectPath) {
    await ctx.reply(`Task \`${taskId}\` no longer exists after update`, { parse_mode: "Markdown" });
    return;
  }

  const projectName = basename(projectPath) || "unknown";
  const baseInfo = baseBranch ? ` (base: \`${baseBranch}\`)` : "";
  await ctx.reply(`Starting mouse for \`${projectName}: ${taskId}\`${baseInfo}...`, { parse_mode: "Markdown" });

  try {
    const spawnOptions: SpawnOptions = { projectPath };
    if (baseBranch) {
      spawnOptions.baseBranch = baseBranch;
    }
    const tmuxName = await spawnSession("mouse", taskId, chatId, spawnOptions);

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
Branch: \`ba/${taskId}\`${baseBranch ? `\nBase: \`${baseBranch}\`` : ""}
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

  // Check if input is a fully qualified session name:
  // - mouse-<taskId>
  // - <project>-drummer-<timestamp>
  // - <project>-notes-<pr>
  // Pattern: matches mouse-*, *-drummer-*, or *-notes-*
  const isFullyQualified =
    input.startsWith("mouse-") ||
    /-drummer-\d+$/.test(input) ||
    /-notes-\d+$/.test(input);

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

/**
 * Find and remove orphaned tmux sessions.
 * Orphaned = tmux session exists (mouse-*, *-drummer-*, *-notes-*) but not tracked in state.
 */
async function handleCleanup(ctx: Context): Promise<void> {
  const orphaned = await getOrphanedSessions();

  if (orphaned.length === 0) {
    await ctx.reply("*Cleanup*\n\n_No orphaned sessions found_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Build message listing orphaned sessions
  const lines: string[] = ["*Cleanup*", "", `Found ${orphaned.length} orphaned session(s):`, ""];
  for (const t of orphaned) {
    lines.push(`  \`${t.name}\``);
  }

  // Build confirmation keyboard
  const keyboard = new InlineKeyboard()
    .text("Remove All", "cleanup:confirm")
    .text("Cancel", "cleanup:cancel");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

async function handleDrummer(ctx: Context): Promise<void> {
  const projectName = ctx.match?.toString().trim();
  if (!projectName) {
    await ctx.reply("Usage: /drummer <project>");
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  // Validate project exists
  const projects = await scanProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    await ctx.reply(`Project \`${projectName}\` not found in PROJECTS_DIR`, {
      parse_mode: "Markdown",
    });
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

  await ctx.reply(`Starting drummer for \`${projectName}\`...`, {
    parse_mode: "Markdown",
  });

  try {
    const tmuxName = await spawnSession("drummer", undefined, chatId, {
      projectPath: project.path,
      projectName: project.name,
    });

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
      `Drummer running for \`${projectName}\`
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
  const args = ctx.match?.toString().trim();
  if (!args) {
    await ctx.reply("Usage: /notes <project> <pr-number>");
    return;
  }

  // Parse arguments: <project> <pr-number>
  const parts = args.split(/\s+/);
  if (parts.length !== 2) {
    await ctx.reply("Usage: /notes <project> <pr-number>\n\nExample: /notes miranda 42");
    return;
  }

  const [projectName, prNumber] = parts;

  // Validate PR number is numeric
  if (!/^\d+$/.test(prNumber)) {
    await ctx.reply("Error: PR number must be numeric (e.g., /notes miranda 42)");
    return;
  }

  // Validate project exists in PROJECTS_DIR
  const projectPath = `${config.projectsDir}/${projectName}`;
  const projects = await scanProjects();
  const projectExists = projects.some((p) => p.name === projectName);
  if (!projectExists) {
    await ctx.reply(`Error: Project \`${projectName}\` not found in ${config.projectsDir}`, {
      parse_mode: "Markdown",
    });
    return;
  }

  // Use project + PR number as session key
  const sessionKey = `notes-${projectName}-${prNumber}`;
  const existing = getSession(sessionKey);
  if (existing) {
    await ctx.reply(`Notes session for ${projectName} PR #${prNumber} already exists (${existing.status})`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  await ctx.reply(`Starting notes for ${projectName} PR #${prNumber}...`, { parse_mode: "Markdown" });

  try {
    const tmuxName = await spawnSession("notes", prNumber, chatId, { projectPath, projectName });

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
      `Notes running for ${projectName} PR #${prNumber}
Session: \`${tmuxName}\`

Addressing human feedback...`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start notes: ${message}`);
  }
}

async function handleUpdate(ctx: Context): Promise<void> {
  await ctx.reply("Updating projects...");

  const projects = await scanProjects();
  if (projects.length === 0) {
    await ctx.reply("*Update*\n\n_No projects found_", { parse_mode: "Markdown" });
    return;
  }

  // Get active sessions to check for projects with running tasks
  const sessions = getAllSessions();
  const activeTaskIds = new Set(
    sessions
      .filter((s) => s.status === "running" || s.status === "waiting_input")
      .map((s) => s.taskId)
  );

  const results: UpdateResult[] = [];

  for (const project of projects) {
    // Check if project has any active tasks
    const projectTasks = await getProjectTasks(project.name);
    const hasActiveTask = projectTasks.some((t) => activeTaskIds.has(t.id));

    if (hasActiveTask) {
      results.push({ name: project.name, status: "skipped_active" });
      continue;
    }

    // Check if repo is dirty
    const dirty = await isRepoDirty(project.path);
    if (dirty) {
      results.push({ name: project.name, status: "skipped_dirty" });
      continue;
    }

    // Pull the project
    const pullResult = await pullProject(project.path);
    if (!pullResult.success) {
      results.push({ name: project.name, status: "error", error: pullResult.error });
    } else if (pullResult.commits === 0) {
      results.push({ name: project.name, status: "already_current" });
    } else {
      results.push({ name: project.name, status: "updated", commits: pullResult.commits });
    }
  }

  // Build response message grouped by status
  const lines: string[] = ["*Update Results*", ""];

  const updated = results.filter((r) => r.status === "updated");
  if (updated.length > 0) {
    lines.push("*Updated:*");
    for (const r of updated) {
      lines.push(`  ${r.name} (+${r.commits} commit${r.commits === 1 ? "" : "s"})`);
    }
    lines.push("");
  }

  const current = results.filter((r) => r.status === "already_current");
  if (current.length > 0) {
    lines.push("*Already current:*");
    for (const r of current) {
      lines.push(`  ${r.name}`);
    }
    lines.push("");
  }

  const skippedDirty = results.filter((r) => r.status === "skipped_dirty");
  if (skippedDirty.length > 0) {
    lines.push("*Skipped (dirty):*");
    for (const r of skippedDirty) {
      lines.push(`  ${r.name}`);
    }
    lines.push("");
  }

  const skippedActive = results.filter((r) => r.status === "skipped_active");
  if (skippedActive.length > 0) {
    lines.push("*Skipped (active task):*");
    for (const r of skippedActive) {
      lines.push(`  ${r.name}`);
    }
    lines.push("");
  }

  const errors = results.filter((r) => r.status === "error");
  if (errors.length > 0) {
    lines.push("*Errors:*");
    for (const r of errors) {
      lines.push(`  ${r.name}: ${r.error}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function handleSelfUpdate(ctx: Context): Promise<void> {
  await ctx.reply("Updating Miranda...");

  const result = await selfUpdate();

  if (!result.success) {
    await ctx.reply(`*Self Update Failed*\n\n\`${result.error}\``, {
      parse_mode: "Markdown",
    });
    return;
  }

  if (result.commits === 0) {
    await ctx.reply("*Self Update*\n\nAlready up to date. Build completed.", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Build message with commit info
  const lines: string[] = [
    "*Self Update*",
    "",
    `Pulled ${result.commits} commit${result.commits === 1 ? "" : "s"}:`,
    "",
  ];

  // Add commit messages (limit to 10 to avoid message size issues)
  const displayCommits = result.commitMessages.slice(0, 10);
  for (const commit of displayCommits) {
    lines.push(`  \`${commit}\``);
  }
  if (result.commitMessages.length > 10) {
    lines.push(`  _... and ${result.commitMessages.length - 10} more_`);
  }

  lines.push("");
  lines.push("Build completed. Restart Miranda to apply changes.");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function handleNewProject(ctx: Context): Promise<void> {
  const repoRef = ctx.match?.toString().trim();
  if (!repoRef) {
    await ctx.reply(
      `Usage: /newproject <repo>

**GitHub repositories only**

Examples:
  /newproject owner/repo
  /newproject https://github.com/owner/repo
  /newproject git@github.com:owner/repo.git`
    );
    return;
  }

  await ctx.reply(`Cloning \`${repoRef}\`...`, { parse_mode: "Markdown" });

  const result = await cloneAndInit(repoRef);

  if (!result.success) {
    await ctx.reply(`Failed: ${result.error}`);
    return;
  }

  if (result.error) {
    // Partial success - cloned but some init failed
    await ctx.reply(
      `Cloned \`${result.repoName}\` to \`${result.projectPath}\`

⚠️ ${result.error}`,
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.reply(
      `Project \`${result.repoName}\` ready

Path: \`${result.projectPath}\`
Initialized: ba, sg, wm`,
      { parse_mode: "Markdown" }
    );
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
