import { exec, execFile } from "child_process";
import { promisify } from "util";
import { access, constants } from "fs/promises";
import { join } from "path";
import { config } from "../config.js";
import { isPathWithin } from "../utils/paths.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Parse a GitHub repo reference into owner, repo, and clone URL.
 *
 * Accepts:
 * - owner/repo (GitHub shorthand)
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - Other full GitHub git URLs
 *
 * Returns null if the input is invalid or refers to a non-GitHub host.
 */
export function parseRepoRef(
  input: string
): { owner: string; repo: string; cloneUrl: string } | null {
  const trimmed = input.trim();

  // GitHub shorthand: owner/repo
  const shorthandMatch = /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)$/.exec(trimmed);
  if (shorthandMatch) {
    const [, owner, repo] = shorthandMatch;
    return {
      owner: owner!,
      repo: repo!.replace(/\.git$/, ""),
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // HTTPS URL: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = /^https:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(
    trimmed
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    return {
      owner: owner!,
      repo: repo!,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // SSH URL: git@github.com:owner/repo.git
  const sshMatch = /^git@github\.com:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(
    trimmed
  );
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return {
      owner: owner!,
      repo: repo!,
      cloneUrl: `git@github.com:${owner}/${repo}.git`,
    };
  }

  // Other git URL - extract repo name from path
  const genericUrlMatch = /^(?:https?|git):\/\/[^/]+\/.*\/([a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(
    trimmed
  );
  if (genericUrlMatch) {
    return {
      owner: "unknown",
      repo: genericUrlMatch[1]!.replace(/\.git$/, ""),
      cloneUrl: trimmed,
    };
  }

  return null;
}

export interface CloneResult {
  success: boolean;
  projectPath?: string;
  repoName?: string;
  error?: string;
}

/**
 * Clone a repository and initialize ba, sg, wm.
 *
 * @param repoRef - owner/repo or full git URL
 * @returns Result with project path or error message
 */
export async function cloneAndInit(repoRef: string): Promise<CloneResult> {
  const parsed = parseRepoRef(repoRef);
  if (!parsed) {
    return { success: false, error: "Invalid repository reference. Use owner/repo or a git URL." };
  }

  const projectPath = join(config.projectsDir, parsed.repo);

  // Verify path stays within projectsDir
  if (!(await isPathWithin(projectPath, config.projectsDir))) {
    return { success: false, error: "Invalid project name (path traversal detected)." };
  }

  // Check if directory already exists
  try {
    await access(projectPath, constants.F_OK);
    return { success: false, error: `Directory already exists: ${parsed.repo}` };
  } catch {
    // Good - directory doesn't exist
  }

  // Clone the repository using execFile to avoid shell injection
  try {
    await execFileAsync("gh", ["repo", "clone", parsed.cloneUrl, projectPath], {
      timeout: 120000, // 2 minute timeout
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Clone failed: ${message}` };
  }

  // Initialize tools with timeouts
  const initErrors: string[] = [];
  const initTimeout = 30000; // 30 second timeout for each init

  try {
    await execAsync("ba init", { cwd: projectPath, timeout: initTimeout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    initErrors.push(`ba init failed: ${message}`);
  }

  try {
    await execAsync("sg init", { cwd: projectPath, timeout: initTimeout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    initErrors.push(`sg init failed: ${message}`);
  }

  try {
    await execAsync("wm init", { cwd: projectPath, timeout: initTimeout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    initErrors.push(`wm init failed: ${message}`);
  }

  if (initErrors.length > 0) {
    return {
      success: true,
      projectPath,
      repoName: parsed.repo,
      error: `Cloned but init had issues:\n${initErrors.join("\n")}`,
    };
  }

  return { success: true, projectPath, repoName: parsed.repo };
}
