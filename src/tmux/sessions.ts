import { exec } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { SkillType } from "../types.js";

const execAsync = promisify(exec);

// AIDEV-NOTE: tmux session naming convention is "mouse-<taskId>" for mouse skill
// This allows easy identification and management of Claude skill sessions

// Pattern: alphanumeric, hyphens, underscores only (ba task IDs follow this)
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that a string is safe for shell interpolation
 * Throws if the string contains shell metacharacters
 */
function validateShellSafe(value: string, name: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${name} format: ${value} (must match ${SAFE_ID_PATTERN})`);
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
 * Uses timestamp to allow multiple drummer runs
 */
export function getDrummerTmuxName(): string {
  const timestamp = Date.now();
  return `drummer-${timestamp}`;
}

/**
 * Generate the tmux session name for a notes session
 * Uses PR number for identification
 */
export function getNotesTmuxName(prNumber: string): string {
  return `notes-${prNumber}`;
}

// Re-export SkillType for consumers that import from sessions.ts
export type { SkillType } from "../types.js";

/** Configuration for each skill type */
interface SkillConfig {
  tmuxName: string;
  skillInvocation: string;
}

/**
 * Get skill configuration based on skill type.
 * Uses switch statement to make adding new skills explicit and catch unknown skills at compile time.
 */
function getSkillConfig(skill: SkillType, taskId: string | undefined): SkillConfig {
  switch (skill) {
    case "mouse": {
      if (!taskId) {
        throw new Error("spawnSession: taskId is required for mouse skill");
      }
      validateShellSafe(taskId, "taskId");
      return {
        tmuxName: getTmuxName(taskId),
        skillInvocation: `mouse ${taskId}`,
      };
    }
    case "drummer": {
      return {
        tmuxName: getDrummerTmuxName(),
        skillInvocation: "drummer",
      };
    }
    case "notes": {
      if (!taskId) {
        throw new Error("spawnSession: PR number is required for notes skill");
      }
      validateShellSafe(taskId, "prNumber");
      return {
        tmuxName: getNotesTmuxName(taskId),
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

/**
 * Spawn a new tmux session running a Claude skill
 *
 * @param skill - The skill to run ("mouse", "drummer", or "notes")
 * @param taskId - The task ID (required for mouse/notes, ignored for drummer)
 * @param chatId - Telegram chat ID for notifications (unused here, tracked by caller)
 * @param projectPath - Working directory for the tmux session (optional, falls back to config.defaultProject)
 * @returns The tmux session name
 */
export async function spawnSession(
  skill: SkillType,
  taskId: string | undefined,
  _chatId: number,
  projectPath?: string
): Promise<string> {
  // _chatId is tracked by the caller (state/db.ts), not used in tmux command

  // Get skill-specific configuration (validates inputs and determines tmux name)
  const { tmuxName, skillInvocation } = getSkillConfig(skill, taskId);

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
  const workDir = projectPath ?? config.defaultProject;
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
 * Kill a tmux session by name
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
 * List Miranda-managed tmux sessions (those with "mouse-" prefix)
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
      // Only return Miranda-managed sessions (mouse-*, drummer-*, or notes-* prefix)
      .filter((session) =>
        session.name.startsWith("mouse-") ||
        session.name.startsWith("drummer-") ||
        session.name.startsWith("notes-")
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
