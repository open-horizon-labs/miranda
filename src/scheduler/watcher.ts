/**
 * PR merge watcher — polls GitHub for merged PRs and auto-starts oh-task
 * for issues whose dependencies have all been resolved.
 *
 * One API call per project per poll cycle (rate-limited by design).
 */

import { config } from "../config.js";
import { getRepoInfo, getOpenIssues, getMergedPRsSince, type MergedPR } from "../api/github.js";
import { parseDependencies } from "../api/deps.js";
import { buildDependencyGraph, findUnblockedIssues, detectCycles, type DependencyGraph } from "./graph.js";
import { scanProjects } from "../projects/scanner.js";
import { spawnSession } from "../bot/commands.js";
import { getSession, setSession, getAllSessions } from "../state/sessions.js";
import type { Session } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectSchedulerState {
  enabled: boolean;
  lastCheckAt: number; // epoch ms
  /** Set of all issue numbers we've seen in dependency trees. */
  trackedIssues: Set<number>;
  /** True once tree completion has been notified (prevents spam). */
  notifiedComplete: boolean;
  /** True once circular dependency notification has been sent (prevents spam). */
  notifiedCycles: boolean;
}

export interface SchedulerProjectStatus {
  enabled: boolean;
  lastCheckAt: number;
}
export interface SchedulerStatus {
  running: boolean;
  pollIntervalMs: number;
  maxConcurrentSessions: number;
  projects: Record<string, SchedulerProjectStatus>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const projectStates = new Map<string, ProjectSchedulerState>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Telegram notification callback.
 * Set via `setNotifier()` during startup so the scheduler can send messages.
 */
let notifyFn: ((chatId: number, text: string) => void) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Set the notification function (called from index.ts with bot.api.sendMessage). */
export function setNotifier(fn: (chatId: number, text: string) => void): void {
  notifyFn = fn;
}

/** Start the scheduler poll loop. */
export function startScheduler(): void {
  if (running) return;
  running = true;

  const interval = config.schedulerPollInterval;
  console.log(`   Scheduler: polling every ${interval / 1000}s, max ${config.schedulerMaxConcurrent} concurrent`);

  // Run first poll after a short delay (let bot finish starting)
  setTimeout(() => {
    if (running) pollAll().catch(logError);
  }, 5_000);

  pollTimer = setInterval(() => {
    if (running) pollAll().catch(logError);
  }, interval);
}

/** Stop the scheduler poll loop. */
export function stopScheduler(): void {
  running = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log("   Scheduler stopped");
}

/** Enable scheduler for a project. */
export function enableProject(projectName: string): void {
  const existing = projectStates.get(projectName);
  if (existing) {
    existing.enabled = true;
  } else {
    projectStates.set(projectName, { enabled: true, lastCheckAt: Date.now(), trackedIssues: new Set(), notifiedComplete: false, notifiedCycles: false });
  }
}

/** Disable scheduler for a project. */
export function disableProject(projectName: string): void {
  const existing = projectStates.get(projectName);
  if (existing) {
    existing.enabled = false;
  }
}

/** Get current scheduler status. */
export function getSchedulerStatus(): SchedulerStatus {
  const projects: Record<string, SchedulerProjectStatus> = {};
  for (const [name, state] of projectStates) {
    projects[name] = { enabled: state.enabled, lastCheckAt: state.lastCheckAt };
  }
  return {
    running,
    pollIntervalMs: config.schedulerPollInterval,
    maxConcurrentSessions: config.schedulerMaxConcurrent,
    projects,
  };
}

/** Manually trigger a poll for a specific project. */
export async function triggerProject(projectName: string): Promise<{
  started: number[];
  alreadyRunning: number[];
  blocked: number[];
  cycles: number[][];
}> {
  const state = projectStates.get(projectName);
  if (!state?.enabled) {
    // Auto-enable on manual trigger
    enableProject(projectName);
  }
  return pollProject(projectName, true);
}

// ---------------------------------------------------------------------------
// Poll Logic
// ---------------------------------------------------------------------------

/** Poll all enabled projects. */
async function pollAll(): Promise<void> {
  const enabledProjects: string[] = [];
  for (const [name, state] of projectStates) {
    if (state.enabled) enabledProjects.push(name);
  }

  if (enabledProjects.length === 0) return;

  // Poll sequentially to avoid hammering GitHub API
  for (const name of enabledProjects) {
    try {
      await pollProject(name);
    } catch (err) {
      logError(err, `scheduler poll for ${name}`);
    }
  }
}

/**
 * Poll a single project for merged PRs and start unblocked issues.
 *
 * Algorithm:
 * 1. Fetch open issues with dependencies
 * 2. Fetch recently merged PRs (since last check)
 * 3. Determine which issues are resolved (closed = not in open issues)
 * 4. Find issues that are now unblocked
 * 5. Start oh-task for unblocked issues (respecting concurrent limit)
 */
async function pollProject(projectName: string, manual = false): Promise<{
  started: number[];
  alreadyRunning: number[];
  blocked: number[];
  cycles: number[][];
}> {
  const result = { started: [] as number[], alreadyRunning: [] as number[], blocked: [] as number[], cycles: [] as number[][] };

  // Resolve project path
  const projects = await scanProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) return result;

  const { owner, repo } = await getRepoInfo(project.path);

  // Get state (create if needed)
  let state = projectStates.get(projectName);
  if (!state) {
    state = { enabled: true, lastCheckAt: Date.now(), trackedIssues: new Set(), notifiedComplete: false, notifiedCycles: false };
    projectStates.set(projectName, state);
    if (!manual) {
      return result; // First automatic run — just record timestamp
    }
    // For manual trigger, look back 24h
    state.lastCheckAt = Date.now() - 24 * 60 * 60 * 1000;
  }

  const since = new Date(state.lastCheckAt);

  // Fetch data from GitHub (one call per resource type)
  const [openIssues, mergedPRs] = await Promise.all([
    getOpenIssues(owner, repo),
    getMergedPRsSince(owner, repo, since),
  ]);

  // Update last check timestamp
  state.lastCheckAt = Date.now();

  // If no PRs merged since last check, nothing to do
  if (mergedPRs.length === 0) return result;

  // Build dependency graph from open issues
  const openIssueNumbers = new Set(openIssues.map((i) => i.number));
  const issuesWithDeps = openIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    dependsOn: parseDependencies(issue.body),
  }));

  const graph = buildDependencyGraph(issuesWithDeps);

  // Detect cycles
  const cycles = detectCycles(graph);
  result.cycles = cycles;
  if (cycles.length > 0 && !state.notifiedCycles) {
    state.notifiedCycles = true;
    const cycleStr = cycles.map((c) => c.map((n) => `#${n}`).join(" → ")).join("; ");
    notify(`⚠️ *${projectName}* scheduler: circular dependencies detected: ${cycleStr}`);
  } else if (cycles.length === 0) {
    state.notifiedCycles = false; // Reset when cycles are resolved
  }

  // Track all issues that are part of dependency trees
  for (const issue of issuesWithDeps) {
    if (issue.dependsOn.length > 0) {
      if (!state.trackedIssues.has(issue.number)) {
        state.trackedIssues.add(issue.number);
        state.notifiedComplete = false; // New issue in tree, reset
      }
      for (const dep of issue.dependsOn) {
        state.trackedIssues.add(dep);
      }
    }
  }

  // Determine resolved issues:
  // An issue is "resolved" if it's NOT in the open issues list.
  // This works because closed issues don't appear in getOpenIssues.
  // For the dependency graph, any dep that's not open is considered resolved.
  const resolvedIssueNumbers = new Set<number>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependsOn) {
      if (!openIssueNumbers.has(dep)) {
        resolvedIssueNumbers.add(dep);
      }
    }
  }

  // Find newly unblocked issues
  const unblocked = findUnblockedIssues(graph, openIssueNumbers, resolvedIssueNumbers);
  if (unblocked.length === 0) {
    // Check tree completion
    checkTreeCompletion(projectName, state, openIssueNumbers);
    return result;
  }

  // Check concurrent session limit
  const activeSessions = getAllSessions().filter(
    (s) => (s.status === "running" || s.status === "waiting_input") && s.skill === "oh-task",
  );
  const availableSlots = config.schedulerMaxConcurrent - activeSessions.length;

  if (availableSlots <= 0) {
    result.blocked = unblocked;
    return result;
  }

  // Start oh-task for unblocked issues (up to available slots)
  const chatId = config.schedulerChatId;
  if (!chatId) {
    console.warn("Scheduler: no chatId configured, cannot start sessions");
    return result;
  }

  const toStart = unblocked.slice(0, availableSlots);
  for (const issueNumber of toStart) {
    const sessionKey = `oh-task-${projectName}-${issueNumber}`;
    const existing = getSession(sessionKey);
    if (existing) {
      result.alreadyRunning.push(issueNumber);
      continue;
    }

    try {
      const sessionId = await spawnSession("oh-task", String(issueNumber), chatId, {
        projectPath: project.path,
        projectName: project.name,
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
      result.started.push(issueNumber);

      // Find which dependency was just resolved (from merged PRs)
      const resolvedDeps = findResolvedDeps(issueNumber, graph, mergedPRs, openIssueNumbers);
      const depInfo = resolvedDeps.length > 0
        ? ` (deps resolved: ${resolvedDeps.map((n) => `#${n} merged`).join(", ")})`
        : "";

      notify(`🤖 Auto-starting *#${issueNumber}* for *${projectName}*${depInfo}`);
    } catch (err) {
      logError(err, `auto-starting #${issueNumber} for ${projectName}`);
    }
  }

  // Report blocked issues (exceeds concurrent limit)
  if (unblocked.length > toStart.length) {
    result.blocked = unblocked.slice(toStart.length);
  }

  // Check tree completion
  checkTreeCompletion(projectName, state, openIssueNumbers);

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find which dependencies of a given issue were resolved by recently merged PRs.
 */
function findResolvedDeps(
  issueNumber: number,
  graph: DependencyGraph,
  mergedPRs: MergedPR[],
  openIssueNumbers: Set<number>,
): number[] {
  const node = graph.nodes.get(issueNumber);
  if (!node) return [];

  // Extract issue numbers linked to merged PRs
  const mergedIssueNumbers = new Set<number>();
  for (const pr of mergedPRs) {
    const linked = extractLinkedIssueNumbers(pr);
    for (const n of linked) {
      mergedIssueNumbers.add(n);
    }
  }

  // Return deps of this issue that are both resolved (not open) and linked to a merged PR
  return node.dependsOn.filter(
    (dep) => !openIssueNumbers.has(dep) && mergedIssueNumbers.has(dep),
  );
}

/**
 * Extract issue numbers linked from a merged PR body and branch name.
 */
function extractLinkedIssueNumbers(pr: MergedPR): number[] {
  const issues = new Set<number>();

  // Check branch name: issue-N, issue/N
  const branchMatch = pr.head.match(/issue[/-](\d+)/);
  if (branchMatch) {
    issues.add(parseInt(branchMatch[1], 10));
  }

  // Check body for Closes/Fixes/Resolves #N
  if (pr.body) {
    const pattern = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(pr.body)) !== null) {
      issues.add(parseInt(match[1], 10));
    }
  }

  return [...issues];
}

/**
 * Check if the entire dependency tree is complete and notify (once).
 * Uses the project's tracked issue set to determine if all known issues are resolved.
 */
function checkTreeCompletion(
  projectName: string,
  state: ProjectSchedulerState,
  openIssueNumbers: Set<number>,
): void {
  if (state.trackedIssues.size === 0) return;
  if (state.notifiedComplete) return;

  // All tracked issues are resolved if none of them are still open
  for (const num of state.trackedIssues) {
    if (openIssueNumbers.has(num)) return; // Still open
  }

  // All tracked issues are resolved
  state.notifiedComplete = true;
  const issueList = [...state.trackedIssues].map((n) => `#${n}`).join(", ");
  notify(`✅ *${projectName}* dependency tree complete: ${issueList} all merged`);
}

/** Send a Telegram notification. */
function notify(text: string): void {
  const chatId = config.schedulerChatId;
  if (!chatId || !notifyFn) {
    console.log(`[scheduler] ${text}`);
    return;
  }
  notifyFn(chatId, text);
}

/** Log errors without crashing the scheduler. */
function logError(err: unknown, context?: string): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[scheduler]${context ? ` ${context}:` : ""} ${message}`);
}
