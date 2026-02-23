/**
 * Dependency scheduler — polls GitHub for stack-ready issues
 * and auto-starts oh-task sessions stacked on their dep's branch.
 *
 * The scheduler does NOT auto-start root issues (no deps or all deps merged).
 * Those require manual /ohtask. Only dependent issues whose parent PR is
 * green (CI + CodeRabbit) and whose session has finished get auto-started.
 *
 * One API call per resource type per project per poll cycle.
 */

import { config } from "../config.js";
import { getRepoInfo, getOpenIssues, getOpenPRs, findLinkedPR, getPREnrichment, type GitHubPR } from "../api/github.js";
import { parseDependencies } from "../api/deps.js";
import { buildDependencyGraph, findStackUnblockedIssues, detectCycles, type DependencyGraph } from "./graph.js";
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
export async function triggerProject(projectName: string): Promise<PollResult> {
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

/** Result of polling a single project. */
interface PollResult {
  stacked: Array<{ issue: number; baseDep: number; baseBranch: string }>;
  alreadyRunning: number[];
  blocked: number[];
  cycles: number[][];
}

/**
 * Poll a single project for stack-ready issues.
 *
 * The scheduler only auto-starts issues that can stack on a dep's branch.
 * Root issues (no deps or all deps resolved) require manual /ohtask.
 *
 * Algorithm:
 * 1. Fetch open issues, open PRs, and recently merged PRs
 * 2. Build dependency graph from open issues
 * 3. Find stack-unblocked issues (exactly one dep has a ready PR, session finished)
 * 4. Start oh-task with --base set to dep's branch
 */
async function pollProject(projectName: string, manual = false): Promise<PollResult> {
  const result: PollResult = { stacked: [], alreadyRunning: [], blocked: [], cycles: [] };

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

  // Fetch data from GitHub
  const [openIssues, openPRs] = await Promise.all([
    getOpenIssues(owner, repo),
    getOpenPRs(owner, repo),
  ]);

  // Update last check timestamp
  state.lastCheckAt = Date.now();

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

  // Find stack-ready deps (PR green + CR approved + session finished)
  const { stackReadyIssues, branchMap } = await buildStackReadySet(
    owner, repo, projectName, openPRs, openIssueNumbers, graph,
  );
  const stackUnblocked = findStackUnblockedIssues(graph, openIssueNumbers, resolvedIssueNumbers, stackReadyIssues);

  if (stackUnblocked.length === 0) {
    checkTreeCompletion(projectName, state, openIssueNumbers);
    return result;
  }

  // Check concurrent session limit
  const activeSessions = getAllSessions().filter(
    (s) => (s.status === "starting" || s.status === "running" || s.status === "waiting_input") && s.skill === "oh-task",
  );
  const availableSlots = config.schedulerMaxConcurrent - activeSessions.length;

  if (availableSlots <= 0) {
    result.blocked = stackUnblocked.map((s) => s.issueNumber);
    return result;
  }

  const chatId = config.schedulerChatId;
  if (!chatId) {
    console.warn("Scheduler: no chatId configured, cannot start sessions");
    return result;
  }

  let slotsRemaining = availableSlots;

  // Spawn stack-unblocked issues (on dep's branch)
  const toStack = stackUnblocked.slice(0, slotsRemaining);
  for (const { issueNumber, baseDep } of toStack) {
    const baseBranch = branchMap.get(baseDep);
    if (!baseBranch) continue;

    const spawned = await trySpawnIssue(projectName, project.path, issueNumber, chatId, baseBranch);
    if (spawned === "already_running") {
      result.alreadyRunning.push(issueNumber);
      continue;
    }
    if (spawned === "started") {
      result.stacked.push({ issue: issueNumber, baseDep, baseBranch });
      slotsRemaining--;
      notify(`🤖 Auto-starting *#${issueNumber}* stacked on *#${baseDep}* (\`${baseBranch}\`) for *${projectName}*`);
    }
  }

  // Report slot-blocked issues
  const startedSet = new Set([...result.stacked.map((s) => s.issue), ...result.alreadyRunning]);
  result.blocked = stackUnblocked.map((s) => s.issueNumber).filter((n) => !startedSet.has(n));

  // Check tree completion
  checkTreeCompletion(projectName, state, openIssueNumbers);

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to spawn an oh-task session for an issue.
 * Returns "started", "already_running", or "error".
 */
async function trySpawnIssue(
  projectName: string,
  projectPath: string,
  issueNumber: number,
  chatId: number,
  baseBranch?: string,
): Promise<"started" | "already_running" | "error"> {
  const sessionKey = `oh-task-${projectName}-${issueNumber}`;
  const existing = getSession(sessionKey);
  if (existing) return "already_running";

  try {
    const sessionId = await spawnSession("oh-task", String(issueNumber), chatId, {
      projectPath,
      projectName,
      baseBranch,
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
    return "started";
  } catch (err) {
    logError(err, `spawning #${issueNumber} for ${projectName}`);
    return "error";
  }
}

/**
 * Build the set of issue numbers whose PR is stack-ready:
 * - Has a linked open PR
 * - CI is green (success)
 * - CodeRabbit review is approved or absent
 * - No active oh-task session for the issue
 *
 * Also returns a map from issue number to the PR's head branch name.
 */
async function buildStackReadySet(
  owner: string,
  repo: string,
  projectName: string,
  openPRs: GitHubPR[],
  openIssueNumbers: Set<number>,
  graph: DependencyGraph,
): Promise<{ stackReadyIssues: Set<number>; branchMap: Map<number, string> }> {
  const stackReadyIssues = new Set<number>();
  const branchMap = new Map<number, string>();

  // Collect all dep issue numbers that are open (potential stack candidates)
  const depCandidates = new Set<number>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependsOn) {
      if (openIssueNumbers.has(dep)) {
        depCandidates.add(dep);
      }
    }
  }

  if (depCandidates.size === 0) {
    return { stackReadyIssues, branchMap };
  }

  // For each dep candidate, check if it has a ready PR and no active session
  const checks = [...depCandidates].map(async (depIssue) => {
    // Must not have an active session
    const sessionKey = `oh-task-${projectName}-${depIssue}`;
    const session = getSession(sessionKey);
    if (session && (session.status === "starting" || session.status === "running" || session.status === "waiting_input")) {
      return; // Session still running
    }

    // Must have a linked open PR
    const pr = findLinkedPR(openPRs, depIssue);
    if (!pr) return;

    // Check CI + CodeRabbit status
    try {
      const enrichment = await getPREnrichment(owner, repo, pr);
      const ciGreen = enrichment.ci.state === "success";
      const crOk = !enrichment.coderabbit.reviewed || enrichment.coderabbit.state === "APPROVED";

      if (ciGreen && crOk) {
        stackReadyIssues.add(depIssue);
        branchMap.set(depIssue, pr.head);
      }
    } catch (err) {
      // Best-effort — skip this dep on API failure
      logError(err, `enrichment check for #${depIssue}`);
    }
  });

  await Promise.all(checks);
  return { stackReadyIssues, branchMap };
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
