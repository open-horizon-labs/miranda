import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { SkillType } from "../types.js";

// Pattern: alphanumeric, hyphens, underscores only (ba task IDs follow this)
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Pattern for branch names: alphanumeric, hyphens, underscores, dots, slashes
const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;

/**
 * Validate that a string is safe for use as an identifier.
 * Throws if the string contains unsafe characters.
 */
function validateIdSafe(value: string, name: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${name} format: ${value} (must match ${SAFE_ID_PATTERN})`);
  }
}

/**
 * Validate that a branch name is safe.
 */
function validateBranchSafe(value: string, name: string): void {
  if (!SAFE_BRANCH_PATTERN.test(value)) {
    throw new Error(`Invalid ${name} format: ${value} (must match ${SAFE_BRANCH_PATTERN})`);
  }
}

// ============================================================================
// RPC Protocol Types (subset needed by Miranda)
// Based on oh-my-pi's packages/coding-agent/src/modes/rpc/rpc-types.ts
// ============================================================================

/** Command sent to agent via stdin */
export type RpcCommand =
  | { type: "prompt"; message: string; images?: string[] }
  | { type: "abort" }
  | { type: "extension_ui_response"; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean };

/** Response from agent to a command */
export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Extension UI request from agent (requesting user interaction) */
export interface RpcExtensionUIRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  // Fields are top-level, not nested in params (oh-my-pi wire format)
  title?: string;
  message?: string;
  options?: string[];  // select options as string array
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  defaultValue?: string;
  notifyType?: "info" | "warning" | "error";  // for notify method
}

/** Agent lifecycle events */
export interface RpcAgentEvent {
  type: "agent_start" | "agent_end" | "turn_start" | "turn_end" | "message_start" | "message_end";
  data?: unknown;
}

/** Tool execution events */
export interface RpcToolEvent {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolName?: string;
  toolCallId?: string;
  data?: unknown;
}

/** Message streaming events */
export interface RpcMessageEvent {
  type: "message_update";
  delta?: {
    type: "text_delta" | "thinking_delta" | "toolcall_delta";
    content?: string;
  };
}

/** Error event */
export interface RpcErrorEvent {
  type: "extension_error";
  error: string;
}

/** All possible events from agent stdout */
export type RpcEvent =
  | RpcResponse
  | RpcExtensionUIRequest
  | RpcAgentEvent
  | RpcToolEvent
  | RpcMessageEvent
  | RpcErrorEvent;

// ============================================================================
// Agent Process Management
// ============================================================================

/** Represents a running agent process */
export interface AgentProcess {
  /** Unique process ID (same as OS pid) */
  pid: number;
  /** The skill being run */
  skill: SkillType;
  /** Internal ID for session tracking */
  sessionId: string;
  /** The child process handle */
  process: ChildProcess;
  /** Readline interface for stdout */
  readline: Interface;
  /** Event handlers */
  handlers: {
    onEvent?: (event: RpcEvent) => void;
    onExit?: (code: number | null, signal: string | null) => void;
    onError?: (error: Error) => void;
  };
}

/** Active agent processes indexed by sessionId */
const agents = new Map<string, AgentProcess>();

/** Options for spawning an agent */
export interface SpawnAgentOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Skill type */
  skill: SkillType;
  /** Session ID for tracking */
  sessionId: string;
  /** Event handler for RPC events */
  onEvent?: (event: RpcEvent) => void;
  /** Handler for process exit */
  onExit?: (code: number | null, signal: string | null) => void;
  /** Handler for process errors */
  onError?: (error: Error) => void;
}

/** Skill configuration */
interface SkillConfig {
  /** The expanded skill prompt to send to the agent */
  skillPrompt: string;
}

/** Options for skill configuration */
interface SkillOptions {
  taskId?: string;
  baseBranch?: string;
  projectName?: string;
}

/**
 * Load and expand a skill's SKILL.md content.
 * Reads from mirandaHome/plugin/skills/<skill-name>/SKILL.md,
 * strips YAML frontmatter, and appends the arguments.
 *
 * This mimics how oh-my-pi's input-controller.ts expands skills.
 */
async function loadSkillContent(skillName: string, args: string): Promise<string> {
  const skillPath = join(config.mirandaHome, "plugin", "skills", skillName, "SKILL.md");

  let content: string;
  try {
    content = await readFile(skillPath, "utf-8");
  } catch (err) {
    throw new Error(`Skill "${skillName}" not found at ${skillPath}. Ensure skills are installed via bootstrap.sh.`);
  }

  // Strip YAML frontmatter (--- ... ---)
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

  // Append arguments only if provided
  return args ? `${body}\n\nARGUMENTS: ${args}` : body;
}

/**
 * Build arguments string for a skill based on options.
 * Validates inputs and returns the arguments to append to the skill prompt.
 */
function buildSkillArgs(skill: SkillType, options: SkillOptions): string {
  const { taskId, baseBranch, projectName } = options;

  switch (skill) {
    case "mouse": {
      if (!taskId) {
        throw new Error("spawnAgent: taskId is required for mouse skill");
      }
      validateIdSafe(taskId, "taskId");
      if (baseBranch) {
        validateBranchSafe(baseBranch, "baseBranch");
      }
      return baseBranch ? `${taskId} ${baseBranch}` : taskId;
    }
    case "drummer": {
      if (!projectName) {
        throw new Error("spawnAgent: projectName is required for drummer skill");
      }
      validateIdSafe(projectName, "projectName");
      return "";  // drummer takes no arguments
    }
    case "notes": {
      if (!taskId) {
        throw new Error("spawnAgent: PR number is required for notes skill");
      }
      if (!projectName) {
        throw new Error("spawnAgent: projectName is required for notes skill");
      }
      validateIdSafe(taskId, "prNumber");
      validateIdSafe(projectName, "projectName");
      return taskId;
    }
    case "oh-task": {
      if (!taskId) {
        throw new Error("spawnAgent: issue number is required for oh-task skill");
      }
      if (!projectName) {
        throw new Error("spawnAgent: projectName is required for oh-task skill");
      }
      validateIdSafe(taskId, "issueNumber");
      validateIdSafe(projectName, "projectName");
      if (baseBranch) {
        validateBranchSafe(baseBranch, "baseBranch");
      }
      return baseBranch ? `${taskId} ${baseBranch}` : taskId;
    }
    case "oh-merge": {
      if (!projectName) {
        throw new Error("spawnAgent: projectName is required for oh-merge skill");
      }
      validateIdSafe(projectName, "projectName");
      return "";  // oh-merge takes no arguments
    }
    case "oh-notes": {
      if (!taskId) {
        throw new Error("spawnAgent: PR number is required for oh-notes skill");
      }
      if (!projectName) {
        throw new Error("spawnAgent: projectName is required for oh-notes skill");
      }
      validateIdSafe(taskId, "prNumber");
      validateIdSafe(projectName, "projectName");
      return taskId;
    }
    case "oh-plan": {
      if (!taskId) {
        throw new Error("spawnAgent: description is required for oh-plan skill");
      }
      if (!projectName) {
        throw new Error("spawnAgent: projectName is required for oh-plan skill");
      }
      validateIdSafe(projectName, "projectName");
      // taskId is the description - don't validate pattern (descriptions contain spaces)
      return taskId;
    }
    default: {
      const _exhaustive: never = skill;
      throw new Error(`spawnAgent: Unknown skill type: ${_exhaustive}`);
    }
  }
}

/**
 * Get skill configuration based on skill type.
 * Reads the SKILL.md content and expands it with arguments.
 *
 * In oh-my-pi RPC mode, slash commands don't work - we must send
 * the expanded skill content as the prompt.
 */
async function getSkillConfig(skill: SkillType, options: SkillOptions): Promise<SkillConfig> {
  const args = buildSkillArgs(skill, options);
  const skillPrompt = await loadSkillContent(skill, args);
  return { skillPrompt };
}

/**
 * Spawn a new agent process running oh-my-pi in RPC mode.
 *
 * @param options - Spawn options including cwd, skill, and handlers
 * @returns The spawned agent process
 */
export function spawnAgent(options: SpawnAgentOptions): AgentProcess {
  const { cwd, skill, sessionId, onEvent, onExit, onError } = options;

  // Check for existing session
  if (agents.has(sessionId)) {
    throw new Error(`Agent session ${sessionId} already exists`);
  }

  // Get the oh-my-pi CLI path from config or environment
  const cliPath = config.ompCliPath;
  if (!cliPath) {
    throw new Error("OMP_CLI_PATH not configured - set environment variable or config");
  }

  // Spawn the agent process
  // Uses bun to run the oh-my-pi CLI in RPC mode
  const proc = spawn("bun", [cliPath, "--mode", "rpc", "--cwd", cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Ensure cargo-installed tools are on PATH
      PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
    },
  });

  if (!proc.pid) {
    throw new Error("Failed to spawn agent process - no PID");
  }

  // Create readline interface for parsing JSON lines from stdout
  const readline = createInterface({
    input: proc.stdout!,
    crlfDelay: Infinity,
  });

  // Create agent handle
  const agent: AgentProcess = {
    pid: proc.pid,
    skill,
    sessionId,
    process: proc,
    readline,
    handlers: { onEvent, onExit, onError },
  };

  // Parse JSON lines from stdout
  readline.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as RpcEvent;
      agent.handlers.onEvent?.(event);
    } catch (err) {
      console.error(`[agent:${sessionId}] Failed to parse stdout line:`, line, err);
    }
  });

  // Handle stderr (log for debugging)
  proc.stderr?.on("data", (data: Buffer) => {
    console.error(`[agent:${sessionId}] stderr:`, data.toString());
  });

  // Handle process exit
  proc.on("exit", (code, signal) => {
    console.log(`[agent:${sessionId}] Process exited with code=${code}, signal=${signal}`);
    readline.close();
    agents.delete(sessionId);
    agent.handlers.onExit?.(code, signal);
  });

  // Handle process errors
  proc.on("error", (err) => {
    console.error(`[agent:${sessionId}] Process error:`, err);
    agent.handlers.onError?.(err);
  });

  // Store the agent
  agents.set(sessionId, agent);

  return agent;
}

/**
 * Send a command to the agent via stdin.
 */
function sendCommand(agent: AgentProcess, command: RpcCommand): void {
  const line = JSON.stringify(command) + "\n";
  agent.process.stdin?.write(line);
}

/**
 * Send a prompt message to the agent.
 *
 * @param agent - The agent process
 * @param message - The message to send (e.g., skill invocation)
 */
export function sendPrompt(agent: AgentProcess, message: string): void {
  sendCommand(agent, { type: "prompt", message });
}

/**
 * Send a UI response to the agent (answering a select/confirm/input dialog).
 *
 * @param agent - The agent process
 * @param id - The request ID from the extension_ui request
 * @param response - The response value, confirmation, or cancellation
 */
export function sendUIResponse(
  agent: AgentProcess,
  id: string,
  response: { value?: unknown; confirmed?: boolean; cancelled?: boolean }
): void {
  sendCommand(agent, {
    type: "extension_ui_response",
    id,
    ...response,
  });
}

/**
 * Send abort command to the agent and then kill the process.
 *
 * @param agent - The agent process
 * @param gracePeriodMs - Time to wait for graceful shutdown before SIGKILL (default: 3000)
 * @returns Whether the agent shut down gracefully
 */
export async function killAgent(agent: AgentProcess, gracePeriodMs = 3000): Promise<boolean> {
  // Send abort command for graceful shutdown
  sendCommand(agent, { type: "abort" });

  // Wait for graceful exit
  const graceful = await new Promise<boolean>((resolve) => {
    let resolved = false;

    const checkInterval = setInterval(() => {
      if (!agents.has(agent.sessionId)) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(true);
        }
      }
    }, 100);

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearInterval(checkInterval);
        resolve(false);
      }
    }, gracePeriodMs);
  });

  // If still running, force kill
  if (agents.has(agent.sessionId)) {
    agent.process.kill("SIGKILL");
    agents.delete(agent.sessionId);
  }

  return graceful;
}

/**
 * Get an agent by session ID.
 */
export function getAgent(sessionId: string): AgentProcess | undefined {
  return agents.get(sessionId);
}

/**
 * Get all active agents.
 */
export function getAllAgents(): AgentProcess[] {
  return Array.from(agents.values());
}

/**
 * Check if an agent is running.
 */
export function isAgentRunning(sessionId: string): boolean {
  return agents.has(sessionId);
}

// Re-export types
export { getSkillConfig, type SkillConfig, type SkillOptions };
