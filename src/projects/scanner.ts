import { readdir, readFile, access, constants } from "fs/promises";
import { join } from "path";
import { config } from "../config.js";
import { isPathWithin } from "../utils/paths.js";

export interface ProjectInfo {
  name: string;
  path: string;
  openCount: number;
  inProgressCount: number;
}

interface BaTask {
  id: string;
  status: string;
  // Other fields exist but we only need status
}

/**
 * Scan PROJECTS_DIR for directories containing .ba/issues.jsonl
 * Returns project info with task counts (open + in_progress)
 */
export async function scanProjects(): Promise<ProjectInfo[]> {
  const projectsDir = config.projectsDir;
  const projects: ProjectInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    // Directory doesn't exist or not readable
    return [];
  }

  for (const entry of entries) {
    const projectPath = join(projectsDir, entry);

    // Verify project path stays within projectsDir (prevents symlink escapes)
    if (!(await isPathWithin(projectPath, projectsDir))) {
      continue; // Symlink escapes projectsDir, skip
    }

    const issuesPath = join(projectPath, ".ba", "issues.jsonl");

    // Check if .ba/issues.jsonl exists
    try {
      await access(issuesPath, constants.R_OK);
    } catch {
      continue; // Not a ba project
    }

    // Count tasks by status
    const counts = await countTasks(issuesPath);
    projects.push({
      name: entry,
      path: projectPath,
      openCount: counts.open,
      inProgressCount: counts.inProgress,
    });
  }

  // Sort by name
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

async function countTasks(
  issuesPath: string
): Promise<{ open: number; inProgress: number }> {
  let open = 0;
  let inProgress = 0;

  try {
    const content = await readFile(issuesPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const task = JSON.parse(line) as BaTask;
        if (task.status === "open") {
          open++;
        } else if (task.status === "in_progress") {
          inProgress++;
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch {
    // File read error
  }

  return { open, inProgress };
}

export interface TaskInfo {
  id: string;
  title: string;
  status: string;
}

/**
 * Get tasks for a specific project by name.
 * Uses `ba ready` to show only unblocked tasks that are ready to work on.
 */
export async function getProjectTasks(projectName: string): Promise<TaskInfo[]> {
  const projectPath = join(config.projectsDir, projectName);

  // Verify project path stays within projectsDir (prevents path traversal and symlink escapes)
  if (!(await isPathWithin(projectPath, config.projectsDir))) {
    return [];
  }

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync("ba", ["ready"], { cwd: projectPath });
    return parseBaReadyOutput(stdout);
  } catch {
    // ba command failed - return empty
    return [];
  }
}

/**
 * Parse the output of `ba ready` command.
 * Format:
 *   ID        P  TYPE     TITLE
 *   ------------------------------------------------------------
 *   kv-lqy3   2  task Sync command docs in README and /star...
 */
function parseBaReadyOutput(output: string): TaskInfo[] {
  const tasks: TaskInfo[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Skip header, separator, and summary lines
    if (line.includes("ID") && line.includes("TYPE") && line.includes("TITLE")) continue;
    if (line.includes("----")) continue;
    if (line.includes("issue(s) ready")) continue;
    if (!line.trim()) continue;

    // Parse fixed-width columns: ID starts at col 2, title starts after TYPE
    // Format: "  kv-lqy3   2  task Sync command docs..."
    const match = line.match(/^\s*(\S+)\s+\d+\s+\S+\s+(.+)$/);
    if (match) {
      const [, id, title] = match;
      tasks.push({
        id,
        title: title.replace(/\.{3}$/, "").trim(), // Remove trailing ellipsis if present
        status: "open", // ba ready only shows ready (open, unblocked) tasks
      });
    }
  }

  return tasks;
}

export interface UpdateResult {
  name: string;
  status: "updated" | "already_current" | "skipped_dirty" | "skipped_active" | "error";
  commits?: number;
  error?: string;
}

/**
 * Check if a project directory has uncommitted changes (dirty).
 */
export async function isRepoDirty(projectPath: string): Promise<boolean> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: projectPath,
    });
    return stdout.trim().length > 0;
  } catch {
    // If git command fails, treat as dirty to be safe
    return true;
  }
}

/**
 * Auto-update a single project if it's clean (no uncommitted changes).
 * Used before task discovery to ensure task list reflects current state.
 * Returns update result for optional logging, but designed for silent operation.
 */
export async function updateProjectIfClean(projectPath: string): Promise<UpdateResult & { path: string }> {
  const name = projectPath.split("/").pop() || projectPath;

  // Check if repo is dirty
  const dirty = await isRepoDirty(projectPath);
  if (dirty) {
    return { name, path: projectPath, status: "skipped_dirty" };
  }

  // Pull the project
  const pullResult = await pullProject(projectPath);
  if (!pullResult.success) {
    return { name, path: projectPath, status: "error", error: pullResult.error };
  } else if (pullResult.commits === 0) {
    return { name, path: projectPath, status: "already_current" };
  } else {
    return { name, path: projectPath, status: "updated", commits: pullResult.commits };
  }
}

/**
 * Pull latest changes for a project using git pull --ff-only.
 * Returns the number of new commits pulled.
 */
export async function pullProject(projectPath: string): Promise<{ success: boolean; commits: number; error?: string }> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    // Get current HEAD before pull
    const { stdout: beforeHead } = await execAsync("git rev-parse HEAD", {
      cwd: projectPath,
    });
    const before = beforeHead.trim();

    // Fetch and pull
    await execAsync("git fetch origin", { cwd: projectPath });
    await execAsync("git pull --ff-only", { cwd: projectPath });

    // Get HEAD after pull
    const { stdout: afterHead } = await execAsync("git rev-parse HEAD", {
      cwd: projectPath,
    });
    const after = afterHead.trim();

    if (before === after) {
      return { success: true, commits: 0 };
    }

    // Count commits between before and after
    const { stdout: countOutput } = await execAsync(
      `git rev-list --count ${before}..${after}`,
      { cwd: projectPath }
    );
    const commits = parseInt(countOutput.trim(), 10) || 0;

    return { success: true, commits };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, commits: 0, error: message };
  }
}

/**
 * Find the project that contains a task by scanning all projects.
 * Task IDs are unique UUIDs across all projects.
 * Returns the project path if found, null otherwise.
 */
export async function findProjectForTask(taskId: string): Promise<string | null> {
  const projectsDir = config.projectsDir;

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const projectPath = join(projectsDir, entry);

    // Verify project path stays within projectsDir (prevents symlink escapes)
    if (!(await isPathWithin(projectPath, projectsDir))) {
      continue; // Symlink escapes projectsDir, skip
    }

    const issuesPath = join(projectPath, ".ba", "issues.jsonl");

    try {
      const content = await readFile(issuesPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const task = JSON.parse(line) as { id: string };
          if (task.id === taskId) {
            return projectPath;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    } catch {
      // File read error - continue to next project
    }
  }

  return null;
}

export interface ResetResult {
  success: boolean;
  previousHead?: string;
  newHead?: string;
  error?: string;
}

/**
 * Get the default branch for a project (main or master).
 * Returns the branch name if found, null otherwise.
 */
export async function getDefaultBranch(projectPath: string): Promise<string | null> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    // Check what origin/HEAD points to (set during clone)
    const { stdout } = await execAsync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: projectPath,
    });
    // Output is "refs/remotes/origin/main" - extract branch name
    const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) {
      return match[1];
    }
  } catch {
    // Fallback: check if origin/main or origin/master exists
    try {
      await execAsync("git rev-parse --verify origin/main", { cwd: projectPath });
      return "main";
    } catch {
      try {
        await execAsync("git rev-parse --verify origin/master", { cwd: projectPath });
        return "master";
      } catch {
        // Neither exists
      }
    }
  }

  return null;
}

/**
 * Hard reset a project to origin/<branch>.
 * Fetches origin first, then resets to the remote branch.
 */
export async function resetProject(projectPath: string): Promise<ResetResult> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    // Get default branch
    const branch = await getDefaultBranch(projectPath);
    if (!branch) {
      return { success: false, error: "Could not determine default branch (no origin/main or origin/master)" };
    }

    // Get current HEAD before reset
    const { stdout: beforeHead } = await execAsync("git rev-parse --short HEAD", {
      cwd: projectPath,
    });
    const previousHead = beforeHead.trim();

    // Fetch origin to get latest
    await execAsync("git fetch origin", { cwd: projectPath, timeout: 60000 });

    // Checkout and reset to origin/<branch>
    await execAsync(`git checkout ${branch}`, { cwd: projectPath, timeout: 10000 });
    await execAsync(`git reset --hard origin/${branch}`, { cwd: projectPath, timeout: 10000 });

    // Clean untracked files and directories
    await execAsync("git clean -fd", { cwd: projectPath });

    // Get new HEAD after reset
    const { stdout: afterHead } = await execAsync("git rev-parse --short HEAD", {
      cwd: projectPath,
    });
    const newHead = afterHead.trim();

    return { success: true, previousHead, newHead };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface SelfUpdateResult {
  success: boolean;
  commits: number;
  commitMessages: string[];
  error?: string;
}

/**
 * Find pnpm executable. When running via systemd, pnpm may not be in PATH.
 * Checks common installation locations and falls back to bare "pnpm" command.
 */
async function findPnpm(): Promise<string> {
  const { homedir } = await import("os");
  const home = homedir();

  // Common pnpm installation locations
  const candidates = [
    join(home, ".local/share/pnpm/pnpm"),
    join(home, ".pnpm-global/bin/pnpm"),
    join(home, ".local/bin/pnpm"),
    join(home, ".corepack/pnpm"),
    "/usr/local/bin/pnpm",
    "/usr/bin/pnpm",
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable, try next
    }
  }

  // Fall back to bare command (relies on PATH)
  return "pnpm";
}

/**
 * Update Miranda itself: git pull --ff-only, pnpm install, pnpm build.
 * Uses config.mirandaHome as the project directory.
 */
export async function selfUpdate(): Promise<SelfUpdateResult> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const mirandaHome = config.mirandaHome;
  const pnpm = await findPnpm();

  try {
    // Check if repo is dirty first
    const dirty = await isRepoDirty(mirandaHome);
    if (dirty) {
      return { success: false, commits: 0, commitMessages: [], error: "Working directory is dirty" };
    }

    // Get current HEAD before pull
    const { stdout: beforeHead } = await execAsync("git rev-parse HEAD", {
      cwd: mirandaHome,
    });
    const before = beforeHead.trim();

    // Fetch and pull
    await execAsync("git fetch origin", { cwd: mirandaHome });
    await execAsync("git pull --ff-only", { cwd: mirandaHome });

    // Get HEAD after pull
    const { stdout: afterHead } = await execAsync("git rev-parse HEAD", {
      cwd: mirandaHome,
    });
    const after = afterHead.trim();

    let commits = 0;
    let commitMessages: string[] = [];

    if (before !== after) {
      // Count commits between before and after
      const { stdout: countOutput } = await execAsync(
        `git rev-list --count ${before}..${after}`,
        { cwd: mirandaHome }
      );
      commits = parseInt(countOutput.trim(), 10) || 0;

      // Get commit messages
      const { stdout: logOutput } = await execAsync(
        `git log --oneline ${before}..${after}`,
        { cwd: mirandaHome }
      );
      commitMessages = logOutput.trim().split("\n").filter(Boolean);
    }

    // Run pnpm install (only if there are updates or always to be safe)
    // 2 minute timeout for install
    await execAsync(`${pnpm} install --frozen-lockfile`, { cwd: mirandaHome, timeout: 120000 });

    // Run pnpm build (1 minute timeout)
    await execAsync(`${pnpm} build`, { cwd: mirandaHome, timeout: 60000 });

    return { success: true, commits, commitMessages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, commits: 0, commitMessages: [], error: message };
  }
}
