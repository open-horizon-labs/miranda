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
