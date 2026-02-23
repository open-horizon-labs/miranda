import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  spawnAgent,
  sendPrompt,
  sendUIResponse,
  killAgent,
  getAgent,
  getAllAgents,
  getSkillConfig,
  type AgentProcess,
  type RpcEvent,
} from "../agent/process.js";
import { handleAgentEvent, handleAgentExit } from "../agent/events.js";
import {
  getSession,
  setSession,
  deleteSession,
  getAllSessions,
  setRestartChatId,
} from "../state/sessions.js";
import { scanProjects, getProjectTasks, isRepoDirty, pullProject, updateProjectIfClean, selfUpdate, resetProject, getDefaultBranch, type UpdateResult } from "../projects/scanner.js";
import { cloneAndInit } from "../projects/clone.js";
import { getRepoInfo, getOpenIssues } from "../api/github.js";
import { config } from "../config.js";
import type { Session, SkillType } from "../types.js";

/**
 * Normalize dash-like characters to standard ASCII hyphens.
 * Mobile keyboards often autocorrect -- to em-dash (—).
 * This ensures command arguments parse correctly regardless of input method.
 */
function normalizeDashes(input: string): string {
  return input
    .replace(/—/g, "--") // em-dash (U+2014) → double hyphen
    .replace(/–/g, "-")  // en-dash (U+2013) → hyphen
    .replace(/−/g, "-"); // minus sign (U+2212) → hyphen
}

/** Shutdown function type for /restart command */
export type ShutdownFn = () => Promise<void>;

// Stored shutdown function (set by registerCommands)
let shutdownFn: ShutdownFn | undefined;

/**
 * Generate a unique session ID for a skill invocation.
 * Format: <skill>-<identifier>-<timestamp>
 */
function generateSessionId(skill: SkillType, identifier: string): string {
  const timestamp = Date.now();
  return `${skill}-${identifier}-${timestamp}`;
}

/** Options for spawning a session */
export interface SpawnOptions {
  projectPath?: string;
  baseBranch?: string;
  projectName?: string;
}

/**
 * Spawn a new agent session.
 * Returns the session ID on success.
 *
 * Event handling is wired up automatically using handleAgentEvent and handleAgentExit
 * from agent/events.ts, which routes extension_ui requests to Telegram.
 */
export async function spawnSession(
  skill: SkillType,
  taskId: string | undefined,
  chatId: number,
  options?: SpawnOptions
): Promise<string> {
  const projectPath = options?.projectPath ?? config.defaultProject;
  if (!projectPath) {
    throw new Error("No project path specified and no default project configured");
  }

  // Get skill configuration (reads and expands SKILL.md)
  const skillConfig = await getSkillConfig(skill, {
    taskId,
    baseBranch: options?.baseBranch,
    projectName: options?.projectName,
  });

  // Generate session ID
  const identifier = taskId ?? options?.projectName ?? "unknown";
  const sessionId = generateSessionId(skill, identifier);

  // Spawn the agent with event handlers wired up
  const agent = spawnAgent({
    cwd: projectPath,
    skill,
    sessionId,
    onEvent: (event: RpcEvent) => handleAgentEvent(agent, event),
    onExit: (code, signal) => handleAgentExit(sessionId, code, signal),
    onError: (err) => {
      console.error(`[session:${sessionId}] Agent error:`, err);
    },
  });

  // Send the expanded skill content as the initial prompt
  sendPrompt(agent, skillConfig.skillPrompt);

  return sessionId;
}

/**
 * Stop an agent session.
 * Returns whether the stop was graceful.
 */
export async function stopSession(sessionId: string): Promise<boolean> {
  const agent = getAgent(sessionId);
  if (!agent) {
    // Session not found - consider it already stopped
    return true;
  }
  return killAgent(agent);
}

/**
 * Kill an agent session immediately.
 */
export async function killSession(sessionId: string): Promise<void> {
  const agent = getAgent(sessionId);
  if (agent) {
    await killAgent(agent, 0); // No grace period
  }
}

/**
 * Register command handlers on the bot instance.
 *
 * Commands implemented:
 * - /start - Welcome message
 * - /projects - List projects with task counts
 * - /tasks <project> - List tasks for a project
 * - /status - List all sessions
 * - /stop <session> - Kill a session (task-id or full session name)
 * - /cleanup - Remove orphaned sessions
 * - /killall - Kill all sessions with confirmation
 * - /ohmerge <project> - Batch merge GitHub issue PRs
 * - /ohnotes <project> <pr-number> - Address PR feedback (GitHub issues)
 * - /ohtask <project> <issue>... - Work GitHub issues
 * - /ohplan <project> <desc> - Plan and create GitHub issues
 * - /ohreview <project> <pr-number> - Review a PR against its linked issue
 * - /newproject <repo> - Clone repo and init sg
 * - /pull - Pull all clean projects
 * - /selfupdate - Pull and rebuild Miranda
 * - /restart - Graceful restart
 * - /logs, /ssh - Stubs for future implementation
 */
export function registerCommands(bot: Bot<Context>, shutdown: ShutdownFn): void {
  // Store shutdown function for handleRestart
  shutdownFn = shutdown;

  bot.command("start", handleStart);
  bot.command("projects", handleProjects);
  bot.command("tasks", handleTasks);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("cleanup", handleCleanup);
  bot.command("killall", handleKillall);
  bot.command("ohmerge", handleOhMerge);
  bot.command("ohnotes", handleOhNotes);
  bot.command("ohtask", handleOhTask);
  bot.command("ohplan", handleOhPlan);
  bot.command("ohreview", handleOhReview);
  bot.command("newproject", handleNewProject);
  bot.command("pull", handlePull);
  bot.command("selfupdate", handleSelfUpdate);
  bot.command("restart", handleRestart);
  bot.command("reset", handleReset);
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
/tasks <project> - Show open GitHub issues
/newproject <repo> - Clone and init new project
/pull - Pull all clean projects
/selfupdate - Pull and rebuild Miranda
/restart - Graceful restart
/reset <project> - Hard reset project to origin
/ohtask <project> <issue>... - Work GitHub issues
/ohplan <project> - List/create planned issues
/ohmerge <project> - Batch merge GitHub issue PRs
/ohnotes <project> <pr> - Address PR feedback
/ohreview <project> <pr> - Review PR against issue
/status - Show active sessions
/stop <session> - Stop a session
/cleanup - Remove orphaned sessions
/killall - Kill all sessions
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
    await ctx.reply("Usage: /tasks <project>\n\nShows all open GitHub issues for a project.");
    return;
  }

  await sendProjectIssues((text, opts) => ctx.reply(text, opts), projectName);
}

async function handleStatus(ctx: Context): Promise<void> {
  const sessions = getAllSessions();
  const agents = getAllAgents();

  if (sessions.length === 0 && agents.length === 0) {
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

  // Orphaned agents (in process map but not in session state)
  const trackedSessionIds = new Set(sessions.map((s) => s.sessionId));
  const orphanedAgents = agents.filter((a) => !trackedSessionIds.has(a.sessionId));
  if (orphanedAgents.length > 0) {
    lines.push("*Orphaned (running but untracked):*");
    for (const a of orphanedAgents) {
      lines.push(`  \`${a.sessionId}\` (pid: ${a.pid})`);
    }
  }

  // Build keyboard with stop buttons for each tracked session
  const keyboard = new InlineKeyboard();
  for (const s of sessions) {
    keyboard.text(`Stop ${s.taskId}`, `stop:${s.taskId}`).row();
  }

  if (sessions.length > 0) {
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }
}

async function handleStop(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim();
  if (!input) {
    await ctx.reply("Usage: /stop <task-id or session-id>");
    return;
  }

  // Try to find session by input (works for both task IDs and session IDs)
  const session = getSession(input);

  if (session) {
    // Found in state - stop by session ID
    try {
      const graceful = await stopSession(session.sessionId);
      deleteSession(input);
      const method = graceful ? "stopped" : "killed";
      await ctx.reply(`Session \`${input}\` ${method}`, { parse_mode: "Markdown" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to stop: ${message}`);
    }
  } else {
    // Not in state - try to stop by session ID directly (might be orphaned)
    try {
      const graceful = await stopSession(input);
      const method = graceful ? "stopped" : "killed";
      await ctx.reply(`Session \`${input}\` ${method} (was not tracked)`, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to stop: ${message}`);
    }
  }
}

/**
 * Get orphaned agents (running but not tracked in session state).
 */
export function getOrphanedAgents(): AgentProcess[] {
  const sessions = getAllSessions();
  const agents = getAllAgents();
  const trackedSessionIds = new Set(sessions.map((s) => s.sessionId));
  return agents.filter((a) => !trackedSessionIds.has(a.sessionId));
}

/**
 * Kill all orphaned agents.
 * Returns the count of agents killed.
 */
export async function cleanupOrphanedSessions(): Promise<number> {
  const orphaned = getOrphanedAgents();
  await Promise.allSettled(orphaned.map((a) => killAgent(a, 0)));
  return orphaned.length;
}

/**
 * Discover orphaned agents on startup.
 * With the new agent process manager, agents don't persist across restarts,
 * so this function now returns 0.
 */
export async function discoverOrphanedSessions(): Promise<number> {
  // Agent processes don't survive Miranda restarts (unlike tmux sessions)
  // This function is kept for API compatibility but does nothing meaningful
  return 0;
}

async function handleCleanup(ctx: Context): Promise<void> {
  const orphaned = getOrphanedAgents();

  if (orphaned.length === 0) {
    await ctx.reply("*Cleanup*\n\n_No orphaned sessions found_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Build message listing orphaned sessions
  const lines: string[] = ["*Cleanup*", "", `Found ${orphaned.length} orphaned session(s):`, ""];
  for (const a of orphaned) {
    lines.push(`  \`${a.sessionId}\` (pid: ${a.pid})`);
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

async function handleKillall(ctx: Context): Promise<void> {
  const sessions = getAllSessions();
  const agents = getAllAgents();

  if (sessions.length === 0 && agents.length === 0) {
    await ctx.reply("*Kill All*\n\n_No sessions to kill_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // Build message listing all sessions that will be killed
  const lines: string[] = ["*Kill All Sessions*", ""];

  if (sessions.length > 0) {
    lines.push("*Tracked sessions:*");
    for (const s of sessions) {
      const statusEmoji =
        s.status === "waiting_input" ? "⏸️" :
        s.status === "running" ? "🔄" : "📋";
      lines.push(`  ${statusEmoji} \`${s.taskId}\` (${s.skill})`);
    }
    lines.push("");
  }

  // Find orphaned agents (running but not tracked)
  const trackedSessionIds = new Set(sessions.map((s) => s.sessionId));
  const orphaned = agents.filter((a) => !trackedSessionIds.has(a.sessionId));
  if (orphaned.length > 0) {
    lines.push("*Orphaned processes:*");
    for (const a of orphaned) {
      lines.push(`  \`${a.sessionId}\``);
    }
    lines.push("");
  }

  const totalCount = sessions.length + orphaned.length;
  lines.push(`_${totalCount} session(s) will be terminated_`);

  // Build confirmation keyboard
  const keyboard = new InlineKeyboard()
    .text("Kill All", "killall:confirm")
    .text("Cancel", "killall:cancel");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * Execute killall - terminate all sessions and clear state.
 * Exported for use by callback handler.
 */
export async function executeKillall(): Promise<{ killed: number; errors: string[] }> {
  const sessions = getAllSessions();
  const agents = getAllAgents();
  const errors: string[] = [];

  // Kill all agents
  const killResults = await Promise.allSettled(
    agents.map((a) => killAgent(a, 0))
  );

  // Check for errors
  killResults.forEach((result, idx) => {
    if (result.status === "rejected") {
      errors.push(`${agents[idx].sessionId}: ${result.reason}`);
    }
  });

  // Clear all tracked sessions from state
  for (const s of sessions) {
    deleteSession(s.taskId);
  }

  return { killed: agents.length, errors };
}

async function handleOhMerge(ctx: Context): Promise<void> {
  const projectName = ctx.match?.toString().trim();
  if (!projectName) {
    await ctx.reply("Usage: /ohmerge <project>");
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

  // Check if an oh-merge session is already running for THIS project
  const sessions = getAllSessions();
  const existingOhMerge = sessions.find(
    (s) => s.skill === "oh-merge" && s.status === "running" && s.sessionId.includes(projectName)
  );
  if (existingOhMerge) {
    await ctx.reply(
      `oh-merge session already running for ${projectName}: \`${existingOhMerge.sessionId}\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.reply(`Starting oh-merge for \`${projectName}\`...`, {
    parse_mode: "Markdown",
  });

  try {
    const sessionId = await spawnSession("oh-merge", undefined, chatId, {
      projectPath: project.path,
      projectName: project.name,
    });

    const session: Session = {
      taskId: sessionId,
      sessionId,
      skill: "oh-merge",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionId, session);

    const keyboard = new InlineKeyboard().text(`Stop ${sessionId}`, `stop:${sessionId}`);
    await ctx.reply(
      `oh-merge running for \`${projectName}\`
Session: \`${sessionId}\`

Reviewing PRs with \`oh-merge\` label...`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start oh-merge: ${message}`);
  }
}

async function handleOhNotes(ctx: Context): Promise<void> {
  const args = ctx.match?.toString().trim();
  if (!args) {
    await ctx.reply("Usage: /ohnotes <project> <pr-number>");
    return;
  }

  // Parse arguments: <project> <pr-number>
  const parts = args.split(/\s+/);
  if (parts.length !== 2) {
    await ctx.reply("Usage: /ohnotes <project> <pr-number>\n\nExample: /ohnotes miranda 42");
    return;
  }

  const [projectName, prNumber] = parts;

  // Validate PR number is numeric
  if (!/^\d+$/.test(prNumber)) {
    await ctx.reply("Error: PR number must be numeric (e.g., /ohnotes miranda 42)");
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
  const sessionKey = `oh-notes-${projectName}-${prNumber}`;
  const existing = getSession(sessionKey);
  if (existing) {
    await ctx.reply(`oh-notes session for ${projectName} PR #${prNumber} already exists (${existing.status})`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  await ctx.reply(`Starting oh-notes for ${projectName} PR #${prNumber}...`, { parse_mode: "Markdown" });

  try {
    const sessionId = await spawnSession("oh-notes", prNumber, chatId, { projectPath, projectName });

    const session: Session = {
      taskId: sessionKey,
      sessionId,
      skill: "oh-notes",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionKey, session);

    const keyboard = new InlineKeyboard().text(`Stop ${sessionKey}`, `stop:${sessionKey}`);
    await ctx.reply(
      `oh-notes running for ${projectName} PR #${prNumber}
Session: \`${sessionId}\`

Addressing GitHub issue PR feedback...`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start oh-notes: ${message}`);
  }
}

async function handleOhReview(ctx: Context): Promise<void> {
  const args = ctx.match?.toString().trim();
  if (!args) {
    await ctx.reply("Usage: /ohreview <project> <pr-number>");
    return;
  }

  // Parse arguments: <project> <pr-number>
  const parts = args.split(/\s+/);
  if (parts.length !== 2) {
    await ctx.reply("Usage: /ohreview <project> <pr-number>\n\nExample: /ohreview miranda 42");
    return;
  }

  const [projectName, prNumber] = parts;

  // Validate PR number is numeric
  if (!/^\d+$/.test(prNumber)) {
    await ctx.reply("Error: PR number must be numeric (e.g., /ohreview miranda 42)");
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
  const sessionKey = `oh-review-${projectName}-${prNumber}`;
  const existing = getSession(sessionKey);
  if (existing) {
    await ctx.reply(`oh-review session for ${projectName} PR #${prNumber} already exists (${existing.status})`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  await ctx.reply(`Starting oh-review for ${projectName} PR #${prNumber}...`, { parse_mode: "Markdown" });

  try {
    const sessionId = await spawnSession("oh-review", prNumber, chatId, { projectPath, projectName });

    const session: Session = {
      taskId: sessionKey,
      sessionId,
      skill: "oh-review",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionKey, session);

    const keyboard = new InlineKeyboard().text(`Stop ${sessionKey}`, `stop:${sessionKey}`);
    await ctx.reply(
      `oh-review running for ${projectName} PR #${prNumber}
Session: \`${sessionId}\`

Reviewing PR against linked issue...`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start oh-review: ${message}`);
  }
}

/** Parsed ohtask command arguments */
interface OhTaskArgs {
  projectName: string;
  issueNumbers: string[];
  baseBranch?: string;
}

/**
 * Parse /ohtask command arguments.
 * Format: /ohtask <project> <issue>... [--base branch]
 * Examples:
 *   /ohtask miranda 42
 *   /ohtask miranda 42 43 44
 *   /ohtask miranda 42 --base feature-branch
 *   /ohtask miranda 42 43 --base feature-branch
 */
function parseOhTaskArgs(input: string): OhTaskArgs | null {
  const normalized = normalizeDashes(input.trim());
  if (!normalized) return null;

  const parts = normalized.split(/\s+/);
  if (parts.length < 2) return null;

  const projectName = parts[0];
  const issueNumbers: string[] = [];
  let baseBranch: string | undefined;

  // Parse remaining arguments
  let i = 1;
  while (i < parts.length) {
    if (parts[i] === "--base") {
      // Next part is the branch name
      if (i + 1 >= parts.length) return null; // --base without value
      baseBranch = parts[i + 1];
      i += 2;
      // Continue parsing - allow issues after --base branch
      continue;
    }
    // Should be an issue number
    const issue = parts[i].replace(/^#/, ""); // Strip leading #
    if (!/^\d+$/.test(issue)) {
      // If not a number and not --base, check if it's a trailing branch (legacy support)
      // Legacy: /ohtask miranda 42 feature-branch
      if (i === parts.length - 1 && issueNumbers.length > 0) {
        baseBranch = parts[i];
        break;
      }
      return null; // Invalid issue number
    }
    issueNumbers.push(issue);
    i++;
  }

  if (issueNumbers.length === 0) return null;

  return { projectName, issueNumbers, baseBranch };
}

async function handleOhTask(ctx: Context): Promise<void> {
  const input = ctx.match?.toString() ?? "";
  const args = parseOhTaskArgs(input);
  if (!args) {
    await ctx.reply(
      `Usage: /ohtask <project> <issue>... [--base branch]

Examples:
  /ohtask miranda 42
  /ohtask miranda 42 43 44
  /ohtask miranda 42 --base feature-branch`
    );
    return;
  }

  const { projectName, issueNumbers, baseBranch } = args;

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

  // Pull latest changes before starting (once for all issues)
  await ctx.reply(`Pulling ${projectName}...`);
  const pullResult = await pullProject(projectPath);
  if (!pullResult.success) {
    await ctx.reply(`Failed to pull ${projectName}: ${pullResult.error}`);
    return;
  }
  if (pullResult.commits > 0) {
    await ctx.reply(`Pulled ${pullResult.commits} commit(s)`);
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  // Check for existing sessions
  const existingSessions: string[] = [];
  const issuesToStart: string[] = [];
  for (const issue of issueNumbers) {
    const sessionKey = `oh-task-${projectName}-${issue}`;
    const existing = getSession(sessionKey);
    if (existing) {
      existingSessions.push(`#${issue} (${existing.status})`);
    } else {
      issuesToStart.push(issue);
    }
  }

  if (existingSessions.length > 0) {
    await ctx.reply(`Skipping existing sessions: ${existingSessions.join(", ")}`);
  }

  if (issuesToStart.length === 0) {
    await ctx.reply("No new issues to start");
    return;
  }

  const baseInfo = baseBranch ? ` (base: \`${baseBranch}\`)` : "";
  const issueList = issuesToStart.map((i) => `#${i}`).join(", ");
  await ctx.reply(`Starting oh-task for ${projectName} ${issueList}${baseInfo}...`, { parse_mode: "Markdown" });

  // Spawn sessions for all issues
  const results: { issue: string; success: boolean; sessionId?: string; error?: string }[] = [];
  for (const issue of issuesToStart) {
    try {
      const spawnOptions: SpawnOptions = { projectPath, projectName };
      if (baseBranch) {
        spawnOptions.baseBranch = baseBranch;
      }
      const sessionId = await spawnSession("oh-task", issue, chatId, spawnOptions);

      const sessionKey = `oh-task-${projectName}-${issue}`;
      const session: Session = {
        taskId: sessionKey,
        sessionId,
        skill: "oh-task",
        status: "running",
        startedAt: new Date(),
        chatId,
      };
      setSession(sessionKey, session);
      results.push({ issue, success: true, sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ issue, success: false, error: message });
    }
  }

  // Build summary message
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const lines: string[] = [];
  if (successful.length > 0) {
    lines.push("*Started:*");
    for (const r of successful) {
      lines.push(`  #${r.issue} → \`${r.sessionId}\``);
    }
  }
  if (failed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("*Failed:*");
    for (const r of failed) {
      lines.push(`  #${r.issue}: ${r.error}`);
    }
  }

  // Build keyboard with stop buttons for successful sessions
  const keyboard = new InlineKeyboard();
  for (const r of successful) {
    const sessionKey = `oh-task-${projectName}-${r.issue}`;
    keyboard.text(`Stop #${r.issue}`, `stop:${sessionKey}`).row();
  }

  if (successful.length > 0) {
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }
}

async function handleOhPlanList(ctx: Context, projectName: string): Promise<void> {
  const projects = await scanProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    await ctx.reply(`Project \`${projectName}\` not found`, { parse_mode: "Markdown" });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(project.path);
    const issues = await getOpenIssues(owner, repo);
    const planned = issues.filter((i) => i.labels.includes("oh-planned"));

    if (planned.length === 0) {
      await ctx.reply(
        `*${projectName}* \u2014 _No planned issues_\n\nUse \`/ohplan ${projectName} <description>\` to create issues.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const lines: string[] = [`*${projectName}* \u2014 ${planned.length} planned issue${planned.length === 1 ? "" : "s"}`, ""];
    for (const issue of planned) {
      lines.push(`#${issue.number} \u00b7 ${issue.title}`);
    }

    const keyboard = new InlineKeyboard();
    for (const issue of planned) {
      keyboard.text(`\u25b6 Execute #${issue.number}`, `ohtask:${projectName}:${issue.number}`).row();
    }
    if (planned.length > 1) {
      keyboard.text(`\u25b6\u25b6 Execute All (${planned.length})`, `ohtaskall:${projectName}`).row();
    }

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to fetch planned issues: ${message}`);
  }
}

async function handleOhPlan(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim() ?? "";
  if (!input) {
    await ctx.reply(
      `Usage:
  /ohplan <project> \u2014 List planned issues
  /ohplan <project> <description> \u2014 Create new planned issues

Examples:
  /ohplan miranda
  /ohplan miranda Add heartbeat monitoring for sessions`
    );
    return;
  }

  // Detect listing mode: no space means project name only
  const firstSpace = input.indexOf(" ");
  if (firstSpace === -1) {
    await handleOhPlanList(ctx, input);
    return;
  }

  const projectName = input.slice(0, firstSpace);
  const description = input.slice(firstSpace + 1).trim();

  if (!description) {
    await handleOhPlanList(ctx, projectName);
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

  // Pull latest changes before starting
  await ctx.reply(`Pulling ${projectName}...`);
  const pullResult = await pullProject(projectPath);
  if (!pullResult.success) {
    await ctx.reply(`Failed to pull ${projectName}: ${pullResult.error}`);
    return;
  }
  if (pullResult.commits > 0) {
    await ctx.reply(`Pulled ${pullResult.commits} commit(s)`);
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  // Use timestamp-based session key since oh-plan creates issues, not works on them
  const timestamp = Date.now();
  const sessionKey = `oh-plan-${projectName}-${timestamp}`;

  await ctx.reply(`Starting oh-plan for \`${projectName}\`...\n\nTask: _${description}_`, {
    parse_mode: "Markdown",
  });

  try {
    const sessionId = await spawnSession("oh-plan", description, chatId, {
      projectPath,
      projectName,
    });

    const session: Session = {
      taskId: sessionKey,
      sessionId,
      skill: "oh-plan",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionKey, session);

    const keyboard = new InlineKeyboard().text(`Stop ${sessionKey}`, `stop:${sessionKey}`);
    await ctx.reply(
      `oh-plan running for \`${projectName}\`
Session: \`${sessionId}\`

Investigating and planning...`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to start oh-plan: ${message}`);
  }
}

async function handlePull(ctx: Context): Promise<void> {
  await ctx.reply("Pulling projects...");

  const projects = await scanProjects();
  if (projects.length === 0) {
    await ctx.reply("*Pull*\n\n_No projects found_", { parse_mode: "Markdown" });
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
  const lines: string[] = ["*Pull Results*", ""];

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
  lines.push("Build completed. Run /restart to apply changes.");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

async function handleRestart(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("Error: Could not determine chat ID");
    return;
  }

  // Check for active sessions
  const sessions = getAllSessions();
  const activeSessions = sessions.filter(
    (s) => s.status === "running" || s.status === "waiting_input"
  );

  if (activeSessions.length > 0) {
    const lines = [
      "*Restart Warning*",
      "",
      `${activeSessions.length} active session(s) found:`,
      "",
    ];
    for (const s of activeSessions) {
      const statusEmoji = s.status === "waiting_input" ? "⏸️" : "🔄";
      lines.push(`  ${statusEmoji} \`${s.taskId}\``);
    }
    lines.push("");
    lines.push("Active sessions will be terminated.");
    lines.push("");
    lines.push("_Restarting..._");

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } else {
    await ctx.reply("_Restarting Miranda..._", { parse_mode: "Markdown" });
  }

  // Store chat ID for "back online" message after restart
  setRestartChatId(chatId);

  // Graceful shutdown (process.exit will be called by shutdownFn)
  if (shutdownFn) {
    await shutdownFn();
  } else {
    // Fallback if shutdown function wasn't set (shouldn't happen)
    await ctx.reply("Error: Shutdown function not available");
  }
}

async function handleReset(ctx: Context): Promise<void> {
  const projectName = ctx.match?.toString().trim();
  if (!projectName) {
    await ctx.reply("Usage: /reset <project>");
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

  // Check for active sessions in this project
  const sessions = getAllSessions();
  const projectTasks = await getProjectTasks(projectName);
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));
  const activeSessions = sessions.filter(
    (s) =>
      (s.status === "running" || s.status === "waiting_input") &&
      projectTaskIds.has(s.taskId)
  );

  if (activeSessions.length > 0) {
    const lines = [
      `*Reset Blocked*`,
      "",
      `${activeSessions.length} active session(s) in ${projectName}:`,
      "",
    ];
    for (const s of activeSessions) {
      const statusEmoji = s.status === "waiting_input" ? "⏸️" : "🔄";
      lines.push(`  ${statusEmoji} \`${s.taskId}\``);
    }
    lines.push("");
    lines.push("Stop these sessions first with /stop");

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  // Get default branch to show in confirmation
  const branch = await getDefaultBranch(project.path);
  if (!branch) {
    await ctx.reply(`Could not determine default branch for \`${projectName}\``, {
      parse_mode: "Markdown",
    });
    return;
  }

  // Show confirmation keyboard
  const keyboard = new InlineKeyboard()
    .text("Reset", `reset:confirm:${projectName}`)
    .text("Cancel", `reset:cancel:${projectName}`);

  await ctx.reply(
    `*Reset ${projectName}*\n\nThis will hard reset to \`origin/${branch}\`, discarding all local changes.\n\nAre you sure?`,
    {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }
  );
}

/**
 * Handle reset confirmation callback from /reset command.
 * Exported for use by callback handler in index.ts.
 */
export async function handleResetCallback(
  projectName: string,
  confirmed: boolean,
  editMessage: (text: string, options?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML" }) => Promise<void>
): Promise<void> {
  if (!confirmed) {
    await editMessage("*Reset*\n\n_Cancelled_", { parse_mode: "Markdown" });
    return;
  }

  // Validate project still exists
  const projects = await scanProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    await editMessage(`*Reset*\n\n_Project ${projectName} not found_`, {
      parse_mode: "Markdown",
    });
    return;
  }

  // Re-check for active sessions (may have started since confirmation prompt)
  const sessions = getAllSessions();
  const projectTasks = await getProjectTasks(projectName);
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));
  const activeSessions = sessions.filter(
    (s) =>
      (s.status === "running" || s.status === "waiting_input") &&
      projectTaskIds.has(s.taskId)
  );

  if (activeSessions.length > 0) {
    await editMessage(
      `*Reset Blocked*\n\n_Session started in ${projectName} since prompt. Stop it first._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Perform the reset
  const result = await resetProject(project.path);

  if (!result.success) {
    await editMessage(`*Reset Failed*\n\n\`${result.error}\``, {
      parse_mode: "Markdown",
    });
    return;
  }

  const headChange =
    result.previousHead === result.newHead
      ? `HEAD unchanged at \`${result.newHead}\``
      : `\`${result.previousHead}\` → \`${result.newHead}\``;

  await editMessage(`*Reset Complete*\n\n${projectName}: ${headChange}`, {
    parse_mode: "Markdown",
  });
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
    const parts = [`Project \`${result.repoName}\` ready\n\nPath: \`${result.projectPath}\``];
    if (result.initialized && result.initialized.length > 0) {
      parts.push(`Initialized: ${result.initialized.join(", ")}`);
    }
    if (result.skipped && result.skipped.length > 0) {
      parts.push(`Already present: ${result.skipped.join(", ")}`);
    }
    await ctx.reply(parts.join("\n"), { parse_mode: "Markdown" });
  }
}

async function handleLogs(ctx: Context): Promise<void> {
  const taskId = ctx.match?.toString().trim();
  if (!taskId) {
    await ctx.reply("Usage: /logs <task-id>");
    return;
  }

  // TODO: Implement log viewing
  await ctx.reply(`Logs for \`${taskId}\`...\n\n_Not yet implemented_`, {
    parse_mode: "Markdown",
  });
}

async function handleSsh(ctx: Context): Promise<void> {
  await ctx.reply(
    `\`\`\`
ssh hetzner
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

  // Get the agent and send the UI response
  const agent = getAgent(session.sessionId);
  if (!agent) {
    await ctx.reply(`Session \`${session.taskId}\` agent not found`, { parse_mode: "Markdown" });
    return;
  }

  try {
    // Send the text as a UI response
    if (session.pendingUIRequestId) {
      sendUIResponse(agent, session.pendingUIRequestId, { value: text });
    }

    // Clear awaiting state and update status
    session.awaitingFreeText = undefined;
    session.pendingUIRequestId = undefined;
    session.pendingUIMethod = undefined;
    session.status = "running";
    setSession(session.taskId, session);

    await ctx.reply(`Sent: "${text}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to send input: ${message}`);
  }
}

/**
 * Send a formatted list of all open GitHub issues for a project.
 * Used by /tasks command and tasks: callback handler.
 */
export async function sendProjectIssues(
  replyFn: (text: string, options?: Record<string, unknown>) => Promise<unknown>,
  projectName: string
): Promise<void> {
  const projects = await scanProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    await replyFn(`Project \`${projectName}\` not found`, { parse_mode: "Markdown" });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(project.path);
    const issues = await getOpenIssues(owner, repo);

    if (issues.length === 0) {
      await replyFn(`*${projectName}* — _No open issues_`, { parse_mode: "Markdown" });
      return;
    }

    const lines: string[] = [`*${projectName}* — ${issues.length} open issue${issues.length === 1 ? "" : "s"}`, ""];
    for (const issue of issues) {
      const labelStr = issue.labels.length > 0
        ? " · " + issue.labels.map((l) => `\`${l}\``).join(" ")
        : "";
      lines.push(`#${issue.number} · ${issue.title}${labelStr}`);
    }

    const keyboard = new InlineKeyboard();
    const planned = issues.filter((i) => i.labels.includes("oh-planned"));
    if (planned.length > 0) {
      lines.push("");
      lines.push(`_${planned.length} planned issue${planned.length === 1 ? "" : "s"} ready to execute_`);
      for (const issue of planned) {
        keyboard.text(`▶ Execute #${issue.number}`, `ohtask:${projectName}:${issue.number}`).row();
      }
    }

    await replyFn(lines.join("\n"), {
      parse_mode: "Markdown",
      ...(planned.length > 0 ? { reply_markup: keyboard } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await replyFn(`Failed to fetch issues: ${message}`);
  }
}

/**
 * Spawn an oh-task session for a single issue.
 * Used by ohtask: callback handler.
 */
export async function spawnOhTaskForIssue(
  projectName: string,
  issueNumber: string,
  chatId: number
): Promise<{ success: boolean; sessionKey: string; sessionId?: string; error?: string }> {
  const projectPath = `${config.projectsDir}/${projectName}`;
  const sessionKey = `oh-task-${projectName}-${issueNumber}`;

  const existing = getSession(sessionKey);
  if (existing) {
    return { success: false, sessionKey, error: `Session already exists (${existing.status})` };
  }

  try {
    const pullResult = await pullProject(projectPath);
    if (!pullResult.success) {
      return { success: false, sessionKey, error: `Pull failed: ${pullResult.error}` };
    }

    const sessionId = await spawnSession("oh-task", issueNumber, chatId, {
      projectPath,
      projectName,
    });

    const session: Session = {
      taskId: sessionKey,
      sessionId,
      skill: "oh-task",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionKey, session);
    return { success: true, sessionKey, sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, sessionKey, error: message };
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
