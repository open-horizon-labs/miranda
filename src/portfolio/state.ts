// =============================================================================
// Portfolio State Computation — produces a PortfolioState snapshot from
// current Miranda state (sessions, GitHub data, scheduler, config).
// =============================================================================

import { getAllSessions } from "../state/sessions.js";
import { scanProjects } from "../projects/scanner.js";
import {
  getRepoInfo,
  getOpenIssues,
  getOpenPRs,
  findLinkedPR,
  getPREnrichment,
  getBranchBehindBy,
  type GitHubPR,
} from "../api/github.js";
import { parseDependencies } from "../api/deps.js";
import {
  buildDependencyGraph,
  getIssueFactoryPhase,
} from "../scheduler/graph.js";
import { config } from "../config.js";
import { deriveAttention } from "./attention.js";
import type {
  PortfolioState,
  AppState,
  PhaseState,
  IssueState,
  IssueStatus,
  PRState,
  AgentState,
  AppHealth,
  Pulse,
  Capacity,
  OvermindState,
  AppAutomationConfig,
} from "./types.js";

// --- Revision counter --------------------------------------------------------

let revisionCounter = 0;

// --- Overmind state (populated via write-back endpoint) ----------------------

let overmindState: OvermindState = {
  attentionItems: [],
  reasoning: null,
  processedAt: null,
  cycleCount: 0,
  defaultActions: [],
};

export function getOvermindState(): OvermindState {
  return overmindState;
}

export function setOvermindState(state: OvermindState): void {
  overmindState = state;
}

// --- Per-app automation config -----------------------------------------------

const automationConfigs = new Map<string, AppAutomationConfig>();

const DEFAULT_AUTOMATION: AppAutomationConfig = {
  autoFixCI: "on",
  autoResolveConflicts: "on",
  autoAddressFeedback: "off",
  autoMerge: "off",
  overrideWindowMs: 10_000,
};

export function getAutomationConfig(appName: string): AppAutomationConfig {
  return automationConfigs.get(appName) ?? { ...DEFAULT_AUTOMATION };
}

export function setAutomationConfig(appName: string, cfg: Partial<AppAutomationConfig>): void {
  const current = getAutomationConfig(appName);
  automationConfigs.set(appName, { ...current, ...cfg });
}

export function getAllAutomationConfigs(): Record<string, AppAutomationConfig> {
  const result: Record<string, AppAutomationConfig> = {};
  for (const [name, cfg] of automationConfigs) {
    result[name] = cfg;
  }
  return result;
}

// --- Snapshot computation ----------------------------------------------------

/**
 * Compute a full PortfolioState snapshot from current Miranda state.
 *
 * Reads from:
 * - getAllSessions() — agent/session state
 * - GitHub data (issues, PRs, labels, enrichment) — cached by github.ts
 * - Scheduler state (queued chains, dep graph)
 * - Config (max concurrent)
 *
 * This is async because it reads cached GitHub data.
 */
export async function computeSnapshot(): Promise<PortfolioState> {
  const now = new Date();
  const sessions = getAllSessions();

  // Build session lookup: sessionKey -> Session
  const sessionByKey = new Map(sessions.map((s) => [s.taskId, s]));

  // Capacity
  const activeSessions = sessions.filter(
    (s) => s.status === "starting" || s.status === "running" || s.status === "waiting_input",
  );
  const capacity: Capacity = {
    maxConcurrent: config.schedulerMaxConcurrent,
    active: activeSessions.length,
    available: Math.max(0, config.schedulerMaxConcurrent - activeSessions.length),
  };

  // Scan projects and build per-app state
  const projects = await scanProjects();
  const apps: AppState[] = [];
  const processedSessionKeys = new Set<string>();

  for (const project of projects) {
    let owner = "";
    let repo = "";
    let repoUrl: string | null = null;

    try {
      const info = await getRepoInfo(project.path);
      owner = info.owner;
      repo = info.repo;
      repoUrl = `https://github.com/${owner}/${repo}`;
    } catch {
      // Project may not have a git remote
    }

    if (!owner || !repo) {
      // No GitHub info — skip factory state derivation
      continue;
    }

    // Fetch GitHub data (uses caches from github.ts — 60s TTL)
    let issues: Awaited<ReturnType<typeof getOpenIssues>> = [];
    let prs: GitHubPR[] = [];
    try {
      [issues, prs] = await Promise.all([
        getOpenIssues(owner, repo),
        getOpenPRs(owner, repo),
      ]);
    } catch (err) {
      console.warn(`[portfolio] Failed to fetch GitHub data for ${owner}/${repo}:`, err instanceof Error ? err.message : err);
    }

    // Parse factory labels → group issues by app and phase
    const openIssueNumbers = new Set(issues.map((i) => i.number));
    const issuesWithDeps = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      dependsOn: parseDependencies(issue.body),
      labels: issue.labels,
    }));

    const graph = buildDependencyGraph(issuesWithDeps);

    // Group issues by factory app
    const appIssueMap = new Map<string, typeof issuesWithDeps>();
    const ungrouped: typeof issuesWithDeps = [];

    for (const issue of issuesWithDeps) {
      const fp = getIssueFactoryPhase(issue.labels);
      if (fp) {
        let group = appIssueMap.get(fp.app);
        if (!group) {
          group = [];
          appIssueMap.set(fp.app, group);
        }
        group.push(issue);
      } else {
        ungrouped.push(issue);
      }
    }

    // Build AppState for each factory app
    for (const [appName, appIssues] of appIssueMap) {
      const phaseMap = new Map<string, typeof appIssues>();
      for (const issue of appIssues) {
        const fp = getIssueFactoryPhase(issue.labels);
        const phaseName = fp?.phase ?? "default";
        let group = phaseMap.get(phaseName);
        if (!group) {
          group = [];
          phaseMap.set(phaseName, group);
        }
        group.push(issue);
      }

      const phases: PhaseState[] = [];
      let lastActivity: string | null = null;

      for (const [phaseName, phaseIssues] of phaseMap) {
        const issueStates: IssueState[] = [];

        for (const issue of phaseIssues) {
          const linkedPR = findLinkedPR(prs, issue.number);
          const sessionKey = `oh-task-${project.name}-${issue.number}`;
          const session = sessionByKey.get(sessionKey);
          if (session) processedSessionKeys.add(sessionKey);

          const allDepsResolved = issue.dependsOn.every(
            (dep) => !openIssueNumbers.has(dep),
          );

          // Derive issue status
          const status = deriveIssueStatus(issue, session, linkedPR, allDepsResolved);

          // Build PR state if linked
          let prState: PRState | null = null;
          if (linkedPR) {
            prState = await buildPRState(owner, repo, linkedPR);
          }

          // Build agent state if session exists
          let agentState: AgentState | null = null;
          if (session) {
            agentState = buildAgentState(session, now);
            if (session.lastToolActivityAt) {
              const ts = session.lastToolActivityAt.toISOString();
              if (!lastActivity || ts > lastActivity) lastActivity = ts;
            }
          }

          issueStates.push({
            number: issue.number,
            title: issue.title,
            phase: phaseName,
            status,
            dependsOn: issue.dependsOn,
            depsResolved: allDepsResolved,
            pr: prState,
            agent: agentState,
            specSummary: null,
            evaluated: false,
            evaluationVerdict: null,
          });
        }

        const phaseStatus = derivePhaseStatus(issueStates);
        phases.push({
          name: phaseName,
          status: phaseStatus,
          issueCount: issueStates.length,
          issueDetails: issueStates,
        });
      }

      const health = deriveAppHealth(phases);
      const currentPhase = phases.find((p) => p.status === "in_progress")?.name ?? null;

      apps.push({
        name: appName,
        project: project.name,
        repo: repoUrl,
        currentPhase,
        phases,
        health,
        lastActivity,
      });
    }

    // Handle ungrouped issues as a "default" app for the project
    if (ungrouped.length > 0) {
      const issueStates: IssueState[] = [];
      let lastActivity: string | null = null;

      for (const issue of ungrouped) {
        const linkedPR = findLinkedPR(prs, issue.number);
        const sessionKey = `oh-task-${project.name}-${issue.number}`;
        const session = sessionByKey.get(sessionKey);
        if (session) processedSessionKeys.add(sessionKey);

        const allDepsResolved = issue.dependsOn.every(
          (dep) => !openIssueNumbers.has(dep),
        );

        const status = deriveIssueStatus(issue, session, linkedPR, allDepsResolved);
        let prState: PRState | null = null;
        if (linkedPR) {
          prState = await buildPRState(owner, repo, linkedPR);
        }

        let agentState: AgentState | null = null;
        if (session) {
          agentState = buildAgentState(session, now);
          if (session.lastToolActivityAt) {
            const ts = session.lastToolActivityAt.toISOString();
            if (!lastActivity || ts > lastActivity) lastActivity = ts;
          }
        }

        issueStates.push({
          number: issue.number,
          title: issue.title,
          phase: null,
          status,
          dependsOn: issue.dependsOn,
          depsResolved: allDepsResolved,
          pr: prState,
          agent: agentState,
          specSummary: null,
          evaluated: false,
          evaluationVerdict: null,
        });
      }

      const phaseStatus = derivePhaseStatus(issueStates);
      const health = deriveAppHealth([{
        name: "default",
        status: phaseStatus,
        issueCount: issueStates.length,
        issueDetails: issueStates,
      }]);

      apps.push({
        name: project.name,
        project: project.name,
        repo: repoUrl,
        currentPhase: null,
        phases: [{
          name: "default",
          status: phaseStatus,
          issueCount: issueStates.length,
          issueDetails: issueStates,
        }],
        health,
        lastActivity,
      });
    }
  }

  // Aux sessions: sessions not tied to any factory app
  const auxSessions: AgentState[] = [];
  for (const session of sessions) {
    if (!processedSessionKeys.has(session.taskId)) {
      auxSessions.push(buildAgentState(session, now));
    }
  }

  // Derive pulse
  const pulse = derivePulse(apps, activeSessions.length);

  // Derive mechanical attention
  const attention = deriveAttention(sessions, apps);

  const snapshot: PortfolioState = {
    _rev: ++revisionCounter,
    version: 1,
    timestamp: now.toISOString(),
    pulse,
    capacity,
    apps,
    auxSessions,
    attention,
    overmind: overmindState,
    automationConfig: getAllAutomationConfigs(),
  };

  return snapshot;
}

// --- Derivation helpers ------------------------------------------------------

function deriveIssueStatus(
  issue: { dependsOn: number[] },
  session: { status: string; signaled?: boolean } | undefined,
  linkedPR: GitHubPR | null,
  allDepsResolved: boolean,
): IssueStatus {
  // Has an open PR and agent is done or signaled -> in_review
  if (linkedPR && (!session || session.signaled || session.status === "stopped")) {
    return "in_review";
  }
  // Active agent session -> in_progress
  if (session && (session.status === "starting" || session.status === "running" || session.status === "waiting_input")) {
    return "in_progress";
  }
  // All deps resolved -> ready to start
  if (allDepsResolved || issue.dependsOn.length === 0) {
    return "ready";
  }
  // Still waiting on deps -> queued
  return "queued";
}

function derivePhaseStatus(issues: IssueState[]): "pending" | "in_progress" | "done" {
  if (issues.length === 0) return "done";
  const allDone = issues.every((i) => i.status === "done");
  if (allDone) return "done";
  const anyActive = issues.some((i) => i.status === "in_progress" || i.status === "in_review");
  if (anyActive) return "in_progress";
  return "pending";
}

function deriveAppHealth(phases: PhaseState[]): AppHealth {
  if (phases.length === 0) return "done";
  const allDone = phases.every((p) => p.status === "done");
  if (allDone) return "done";

  // Check for any active agents
  const allIssues = phases.flatMap((p) => p.issueDetails);
  const hasActiveAgent = allIssues.some((i) => i.agent && i.agent.status === "running");
  const hasWaitingAgent = allIssues.some(
    (i) => i.agent && i.agent.status === "waiting_input",
  );
  const hasBlockedIssue = allIssues.some((i) => i.status === "queued");

  if (hasActiveAgent) return "progressing";
  if (hasWaitingAgent) return "waiting";
  if (hasBlockedIssue) return "blocked";

  // No active agents, not all done, nothing waiting — stalled
  return "stalled";
}

function derivePulse(apps: AppState[], activeSessionCount: number): Pulse {
  if (apps.length === 0 && activeSessionCount === 0) return "idle";
  const hasError = apps.some((a) => a.health === "stalled");
  if (hasError) return "error";
  const hasBlocked = apps.some((a) => a.health === "blocked" || a.health === "waiting");
  if (hasBlocked) return "blocked";
  const hasActive = apps.some((a) => a.health === "progressing");
  if (hasActive || activeSessionCount > 0) return "active";
  return "idle";
}

function buildAgentState(
  session: {
    taskId: string;
    skill?: string;
    label?: string;
    status: string;
    startedAt: Date;
    lastToolActivityAt?: Date;
  },
  now: Date,
): AgentState {
  const elapsed = now.getTime() - session.startedAt.getTime();
  const minutes = Math.floor(elapsed / 60000);
  let duration: string;
  if (minutes < 60) {
    duration = `${minutes}m`;
  } else {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    duration = `${hours}h ${remainingMinutes}m`;
  }

  return {
    sessionKey: session.taskId,
    skill: session.skill ?? null,
    label: session.label ?? null,
    status: session.status as AgentState["status"],
    startedAt: session.startedAt.toISOString(),
    lastToolActivityAt: session.lastToolActivityAt?.toISOString() ?? null,
    duration,
  };
}

async function buildPRState(owner: string, repo: string, pr: GitHubPR): Promise<PRState> {
  let ci: PRState["ci"] = "none";
  let review: PRState["review"] = null;
  let behindBase = false;

  try {
    const enrichment = await getPREnrichment(owner, repo, pr);
    ci = enrichment.ci.state;
    review = enrichment.coderabbit.reviewed ? enrichment.coderabbit.state : null;
  } catch (err) {
    console.warn(`[portfolio] PR enrichment failed for ${owner}/${repo}#${pr.number}:`, err instanceof Error ? err.message : err);
  }

  // Check if branch is behind base
  const isStacked = pr.base !== "main" && pr.base !== "master";
  if (isStacked) {
    try {
      const behind = await getBranchBehindBy(owner, repo, pr.base, pr.head);
      behindBase = behind > 0;
    } catch (err) {
      console.warn(`[portfolio] Branch behind-by check failed for ${pr.head}:`, err instanceof Error ? err.message : err);
    }
  }

  const hasConflicts = pr.mergeable === false;

  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    base: pr.base,
    head: pr.head,
    ci,
    review,
    behindBase,
    hasConflicts,
  };
}
