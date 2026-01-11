import { exec } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { SkillType } from "../types.js";

const execAsync = promisify(exec);

// AIDEV-NOTE: tmux session naming conventions:
// - mouse: "mouse-<taskId>"
// - drummer: "<project>-drummer-<timestamp>"
// - notes: "<project>-notes-<prNumber>"
// This allows easy identification of which project a session belongs to.

// Pattern: alphanumeric, hyphens, underscores only (ba task IDs follow this)
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Pattern for branch names: alphanumeric, hyphens, underscores, dots, slashes
const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;

/**
 * Validate that a string is safe for shell interpolation
 * Throws if the string contains shell metacharacters
 */
function validateShellSafe(value: string, name: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${name} format: ${value} (must match ${SAFE_ID_PATTERN})`);
  }
}

/**
 * Validate that a branch name is safe for shell interpolation
 */
function validateBranchSafe(value: string, name: string): void {
  if (!SAFE_BRANCH_PATTERN.test(value)) {
    throw new Error(`Invalid ${name} format: ${value} (must match ${SAFE_BRANCH_PATTERN})`);
  }
}

export interface TmuxSession {
  name: string;
  created: string;
  attached: boolean;
}

/**
 * Generate the tmux session name for a task
 */
export function getTmuxName(taskId: string): string {
  return `mouse-${taskId}`;
}

/**
 * Generate the tmux session name for a drummer session
 * Uses project name and timestamp for identification
 */
export function getDrummerTmuxName(projectName: string): string {
  const timestamp = Date.now();
  return `${projectName}-drummer-${timestamp}`;
}

/**
 * Generate the tmux session name for a notes session
 * Uses project name and PR number for identification
 */
export function getNotesTmuxName(projectName: string, prNumber: string): string {
  return `${projectName}-notes-${prNumber}`;
}

// Re-export SkillType for consumers that import from sessions.ts
export type { SkillType } from "../types.js";

/** Configuration for each skill type */
interface SkillConfig {
  tmuxName: string;
  skillInvocation: string;
}

/** Options for skill configuration */
interface SkillOptions {
  taskId?: string;
  baseBranch?: string;
  projectName?: string;
}

/**
 * Get skill configuration based on skill type.
 * Uses switch statement to make adding new skills explicit and catch unknown skills at compile time.
 */
function getSkillConfig(skill: SkillType, options: SkillOptions): SkillConfig {
  const { taskId, baseBranch, projectName } = options;
  switch (skill) {
    case "mouse": {
      if (!taskId) {
        throw new Error("spawnSession: taskId is required for mouse skill");
      }
      validateShellSafe(taskId, "taskId");
      if (baseBranch) {
        validateBranchSafe(baseBranch, "baseBranch");
      }
      const baseArg = baseBranch ? ` ${baseBranch}` : "";
      return {
        tmuxName: getTmuxName(taskId),
        skillInvocation: `mouse ${taskId}${baseArg}`,
      };
    }
    case "drummer": {
      if (!projectName) {
        throw new Error("spawnSession: projectName is required for drummer skill");
      }
      validateShellSafe(projectName, "projectName");
      return {
        tmuxName: getDrummerTmuxName(projectName),
        skillInvocation: "drummer",
      };
    }
    case "notes": {
      if (!taskId) {
        throw new Error("spawnSession: PR number is required for notes skill");
      }
      if (!projectName) {
        throw new Error("spawnSession: projectName is required for notes skill");
      }
      validateShellSafe(taskId, "prNumber");
      validateShellSafe(projectName, "projectName");
      return {
        tmuxName: getNotesTmuxName(projectName, taskId),
        skillInvocation: `notes ${taskId}`,
      };
    }
    default: {
      // Exhaustiveness guard: TypeScript will error here if a new SkillType is added but not handled
      const _exhaustive: never = skill;
      throw new Error(`spawnSession: Unknown skill type: ${_exhaustive}`);
    }
  }
}

/** Options for spawning a session */
export interface SpawnOptions {
  projectPath?: string;
  baseBranch?: string;
  projectName?: string;
}

/**
 * Spawn a new tmux session running a Claude skill
 *
 * @param skill - The skill to run ("mouse", "drummer", or "notes")
 * @param taskId - The task ID (required for mouse/notes, ignored for drummer)
 * @param chatId - Telegram chat ID for notifications (unused here, tracked by caller)
 * @param options - Optional settings: projectPath (working directory), baseBranch (for stacked PRs)
 * @returns The tmux session name
 */
export async function spawnSession(
  skill: SkillType,
  taskId: string | undefined,
  _chatId: number,
  options?: SpawnOptions
): Promise<string> {
  // _chatId is tracked by the caller (state/db.ts), not used in tmux command

  // Get skill-specific configuration (validates inputs and determines tmux name)
  const { tmuxName, skillInvocation } = getSkillConfig(skill, {
    taskId,
    baseBranch: options?.baseBranch,
    projectName: options?.projectName,
  });

  // Build the claude command
  // Format: env PATH=$HOME/.cargo/bin:$PATH claude '<skill> [taskId]' --dangerously-skip-permissions
  // AIDEV-NOTE: --dangerously-skip-permissions is safe here because Miranda controls
  // what skills/tasks are spawned, and permission prompts would block autonomous flow.
  // The mouse skill itself handles safety through its own review process (sg review).
  // AIDEV-NOTE: Prepend cargo bin to PATH so cargo-installed tools (sg, ba, wm) take precedence.
  // Without this, system tools like ast-grep's 'sg' may shadow superego's 'sg'.
  const claudeCmd = `env PATH=\\$HOME/.cargo/bin:\\$PATH claude '${skillInvocation}' --dangerously-skip-permissions`;

  // Spawn detached tmux session
  // -d: detached (don't attach to it)
  // -s: session name
  // -e: set TMUX_SESSION env var for notify-miranda.sh hook to identify session
  // -c: start directory (projectPath or config.defaultProject)
  let startDirFlag = "";
  const workDir = options?.projectPath ?? config.defaultProject;
  if (workDir) {
    const escapedPath = workDir.replace(/'/g, "'\\''");
    startDirFlag = ` -c '${escapedPath}'`;
  }
  // Pass both TMUX_SESSION (for hook to identify session) and MIRANDA_PORT (for completion signaling)
  const cmd = `tmux new-session -d -s ${tmuxName}${startDirFlag} -e TMUX_SESSION=${tmuxName} -e MIRANDA_PORT=${config.hookPort} "${claudeCmd}"`;

  await execAsync(cmd);
  return tmuxName;
}

/**
 * Kill a tmux session by name (immediate SIGKILL)
 *
 * Use for cleanup/bulk operations (killall, cleanup) or when the session
 * has already signaled completion. For user-initiated stops, prefer
 * stopSession() which attempts graceful shutdown first.
 *
 * @param tmuxName - The tmux session name to kill
 */
export async function killSession(tmuxName: string): Promise<void> {
  validateShellSafe(tmuxName, "tmuxName");

  try {
    await execAsync(`tmux kill-session -t ${tmuxName}`);
  } catch (error) {
    // Session might not exist, which is fine
    const err = error as { stderr?: string };
    if (!err.stderr?.includes("no server running") && !err.stderr?.includes("session not found")) {
      throw error;
    }
  }
}

/**
 * Check if a tmux session exists
 */
async function sessionExists(tmuxName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t ${tmuxName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop a tmux session gracefully with fallback to force kill.
 *
 * 1. Sends Ctrl-C (SIGINT) to allow graceful shutdown
 * 2. Waits up to 3 seconds for session to exit
 * 3. Falls back to kill-session (SIGKILL) if still running
 *
 * @param tmuxName - The tmux session name to stop
 * @returns Whether graceful stop succeeded (true) or fell back to kill (false)
 */
export async function stopSession(tmuxName: string): Promise<boolean> {
  validateShellSafe(tmuxName, "tmuxName");

  // Check if session exists first
  if (!(await sessionExists(tmuxName))) {
    return true; // Already gone, consider it graceful
  }

  // Send Ctrl-C for graceful shutdown
  try {
    await execAsync(`tmux send-keys -t ${tmuxName} C-c`);
  } catch {
    // If we can't send keys, session may already be gone
    if (!(await sessionExists(tmuxName))) {
      return true;
    }
    // Fall through to wait loop, then force kill if still running
  }

  // Wait up to 3 seconds for graceful exit (check every 500ms)
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    if (!(await sessionExists(tmuxName))) {
      return true; // Graceful shutdown succeeded
    }
  }

  // Still running - force kill
  await killSession(tmuxName);
  return false;
}

/**
 * Send text input to a tmux session (simulates user typing)
 *
 * @param tmuxName - The tmux session name
 * @param text - The text to send (will be followed by Enter)
 */
export async function sendKeys(tmuxName: string, text: string): Promise<void> {
  validateShellSafe(tmuxName, "tmuxName");

  // Escape single quotes in the text for shell safety
  const escapedText = text.replace(/'/g, "'\\''");
  await execAsync(`tmux send-keys -t ${tmuxName} '${escapedText}' Enter`);
}

/**
 * List Miranda-managed tmux sessions
 * Matches: mouse-*, *-drummer-*, *-notes-*
 *
 * @returns Array of tmux session info for Miranda sessions only
 */
export async function listTmuxSessions(): Promise<TmuxSession[]> {
  try {
    // Format: name:created:attached (1 or 0)
    const { stdout } = await execAsync(
      `tmux list-sessions -F '#{session_name}:#{session_created}:#{session_attached}'`
    );

    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, created, attached] = line.split(":");
        return {
          name,
          created,
          attached: attached === "1",
        };
      })
      // Only return Miranda-managed sessions:
      // - mouse-<taskId>
      // - <project>-drummer-<timestamp>
      // - <project>-notes-<pr>
      .filter((session) =>
        session.name.startsWith("mouse-") ||
        /-drummer-\d+$/.test(session.name) ||
        /-notes-\d+$/.test(session.name)
      );
  } catch (error) {
    // No tmux server running means no sessions
    const err = error as { stderr?: string };
    if (err.stderr?.includes("no server running")) {
      return [];
    }
    throw error;
  }
}
