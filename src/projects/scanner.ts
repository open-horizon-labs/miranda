import { readdir, readFile, access, constants } from "fs/promises";
import { join } from "path";
import { config } from "../config.js";

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
