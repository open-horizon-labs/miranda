import { exec } from "node:child_process";
import { promisify } from "node:util";

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
 * Spawn a new tmux session running a Claude skill
 *
 * @param skill - The skill to run (e.g., "mouse", "drummer")
 * @param taskId - The task ID to pass to the skill
 * @param chatId - Telegram chat ID for notifications (unused here, tracked by caller)
 * @returns The tmux session name
 */
export async function spawnSession(
  skill: string,
  taskId: string,
  chatId: number
): Promise<string> {
  // Validate inputs to prevent command injection
  validateShellSafe(skill, "skill");
  validateShellSafe(taskId, "taskId");

  // chatId is tracked by the caller (state/db.ts), not used in tmux command
  void chatId;

  const tmuxName = getTmuxName(taskId);

  // Build the claude command
  // Format: claude '<skill> <taskId>' --dangerously-skip-permissions
  // AIDEV-NOTE: --dangerously-skip-permissions is safe here because Miranda controls
  // what skills/tasks are spawned, and permission prompts would block autonomous flow.
  // The mouse skill itself handles safety through its own review process (sg review).
  const claudeCmd = `claude '${skill} ${taskId}' --dangerously-skip-permissions`;

  // Spawn detached tmux session
  // -d: detached (don't attach to it)
  // -s: session name
  const cmd = `tmux new-session -d -s ${tmuxName} "${claudeCmd}"`;

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
      // Only return Miranda-managed sessions (mouse-* prefix)
      .filter((session) => session.name.startsWith("mouse-"));
  } catch (error) {
    // No tmux server running means no sessions
    const err = error as { stderr?: string };
    if (err.stderr?.includes("no server running")) {
      return [];
    }
    throw error;
  }
}
