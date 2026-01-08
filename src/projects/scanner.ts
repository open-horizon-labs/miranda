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
 * Returns open and in_progress tasks only.
 */
export async function getProjectTasks(projectName: string): Promise<TaskInfo[]> {
  const projectPath = join(config.projectsDir, projectName);

  // Verify project path stays within projectsDir (prevents path traversal and symlink escapes)
  if (!(await isPathWithin(projectPath, config.projectsDir))) {
    return [];
  }

  const issuesPath = join(projectPath, ".ba", "issues.jsonl");
  const tasks: TaskInfo[] = [];

  try {
    const content = await readFile(issuesPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const task = JSON.parse(line) as { id: string; title: string; status: string };
        if (task.status === "open" || task.status === "in_progress") {
          tasks.push({
            id: task.id,
            title: task.title,
            status: task.status,
          });
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch {
    // File read error - return empty
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

export interface SelfUpdateResult {
  success: boolean;
  commits: number;
  commitMessages: string[];
  error?: string;
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
    await execAsync("pnpm install --frozen-lockfile", { cwd: mirandaHome, timeout: 120000 });

    // Run pnpm build (1 minute timeout)
    await execAsync("pnpm build", { cwd: mirandaHome, timeout: 60000 });

    return { success: true, commits, commitMessages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, commits: 0, commitMessages: [], error: message };
  }
}
