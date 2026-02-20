import type { IncomingMessage, ServerResponse } from "node:http";
import { getAllSessions, getSession, deleteSession, setSession } from "../state/sessions.js";
import { scanProjects, pullProject } from "../projects/scanner.js";
import { stopSession, spawnSession, type SpawnOptions } from "../bot/commands.js";
import { validateInitData, type TelegramUser } from "./auth.js";
import { parseDependencies } from "./deps.js";
import {
  getRepoInfo,
  getOpenIssues,
  getOpenPRs,
  mergePR,
  commentOnPR,
  findLinkedPR,
  getPREnrichment,
  GitHubRateLimitError,
  type GitHubPR,
  type PREnrichment,
} from "./github.js";
import type { Session } from "../types.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-telegram-init-data",
};

/**
 * Format elapsed time since a date as a human-readable string.
 */
function formatElapsed(startedAt: Date): string {
  const elapsed = Date.now() - startedAt.getTime();
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Send a JSON response.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  });
  res.end(payload);
}

/**
 * Read the request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Parse JSON body from request. Returns null on parse failure.
 */
async function parseJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  try {
    const raw = await readBody(req);
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Authenticate an API request using Telegram initData.
 * Returns the validated TelegramUser on success, or null if 401 was sent.
 */
function requireAuth(req: IncomingMessage, res: ServerResponse): TelegramUser | null {
  const initData = req.headers["x-telegram-init-data"];
  if (typeof initData !== "string" || !initData) {
    json(res, 401, { error: "Missing x-telegram-init-data header" });
    return null;
  }
  const user = validateInitData(initData);
  if (!user) {
    json(res, 401, { error: "Invalid or expired authentication" });
    return null;
  }
  return user;
}

/**
 * Resolve a project name to its path. Returns null if not found.
 */
async function resolveProject(name: string): Promise<string | null> {
  const projects = await scanProjects();
  const project = projects.find((p) => p.name === name);
  return project?.path ?? null;
}


/**
 * GET /api/sessions — All sessions with status, elapsed time, skill type.
 */
export function handleGetSessions(_req: IncomingMessage, res: ServerResponse): void {
  const sessions = getAllSessions();
  const result = sessions.map((s) => ({
    taskId: s.taskId,
    sessionId: s.sessionId,
    skill: s.skill,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    elapsed: formatElapsed(s.startedAt),
    pendingQuestion: s.pendingQuestion
      ? {
          messageId: s.pendingQuestion.messageId,
          questions: s.pendingQuestion.questions.map((q) => q.question),
          receivedAt: s.pendingQuestion.receivedAt.toISOString(),
        }
      : null,
  }));
  json(res, 200, { sessions: result });
}

/**
 * GET /api/projects — All projects from PROJECTS_DIR with task counts.
 */
export async function handleGetProjects(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const projects = await scanProjects();
    const result = projects.map((p) => ({
      name: p.name,
      path: p.path,
      openCount: p.openCount,
      inProgressCount: p.inProgressCount,
    }));
    json(res, 200, { projects: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * POST /api/sessions/:id/stop — Stop a session by taskId.
 */
export async function handleStopSession(
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string
): Promise<void> {
  const session = getSession(taskId);
  if (!session) {
    json(res, 404, { error: "Session not found" });
    return;
  }

  try {
    const graceful = await stopSession(session.sessionId);
    deleteSession(taskId);
    const method = graceful ? "stopped" : "killed";
    json(res, 200, { taskId, method });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * GET /api/projects/:name/issues — Open issues with parsed dependencies.
 */
async function handleGetIssues(
  _req: IncomingMessage,
  res: ServerResponse,
  projectName: string
): Promise<void> {
  const projectPath = await resolveProject(projectName);
  if (!projectPath) {
    json(res, 404, { error: `Project "${projectName}" not found` });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(projectPath);
    const [issues, prs] = await Promise.all([
      getOpenIssues(owner, repo),
      getOpenPRs(owner, repo),
    ]);

    // Build set of issue numbers that have a merged PR (approximation: check closed PRs
    // that reference the issue). For open issues, we check if there's a linked open PR.
    // We consider an issue "resolved" for blocking purposes if it has an open PR that
    // is linked to it — but truly resolved means merged. Since we only fetch open PRs,
    // we'll use the absence of the issue from our open issues list as the merge indicator.
    // Issues that are closed are not in our list (we only fetch state=open).
    // For blockedBy computation, an issue is blocked if its dependency is still open
    // (still appears in our open issues list) AND has no linked PR ready to merge.
    const openIssueNumbers = new Set(issues.map((i) => i.number));

    // Issues with a merged PR are NOT in our open issues list (they'd be closed).
    // So mergedIssues = all issue numbers that are NOT in openIssueNumbers.
    // We don't know all closed issues, but for blocking:
    // If a dependency is not in open issues, it's either closed/merged or doesn't exist.
    // Either way, it's not blocking. If it IS open, it IS blocking.
    // So: mergedIssues is the complement of openIssueNumbers — we pass openIssueNumbers as "unresolved".
    const result = issues.map((issue) => {
      const dependsOn = parseDependencies(issue.body);
      const blockedBy = dependsOn.filter((dep) => openIssueNumbers.has(dep));
      const linkedPR = findLinkedPR(prs, issue.number);

      return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels,
        dependsOn,
        blockedBy,
        pr: linkedPR
          ? {
              number: linkedPR.number,
              state: linkedPR.state,
              mergeable: linkedPR.mergeable,
              url: linkedPR.html_url,
            }
          : null,
      };
    });

    const repoUrl = `https://github.com/${owner}/${repo}`;
    json(res, 200, { repoUrl, issues: result });
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      json(res, 429, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * GET /api/projects/:name/prs — Open PRs with linked issue info.
 */
async function handleGetPRs(
  _req: IncomingMessage,
  res: ServerResponse,
  projectName: string
): Promise<void> {
  const projectPath = await resolveProject(projectName);
  if (!projectPath) {
    json(res, 404, { error: `Project "${projectName}" not found` });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(projectPath);
    const prs = await getOpenPRs(owner, repo);

    const result = prs.map((pr) => {
      // Extract linked issue numbers from PR body and branch name
      const linkedIssues = extractLinkedIssueNumbers(pr);

      return {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        mergeable: pr.mergeable,
        url: pr.html_url,
        base: pr.base,
        head: pr.head,
        linkedIssues,
      };
    });

    json(res, 200, { prs: result });
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      json(res, 429, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * Extract issue numbers linked from a PR (via body references and branch name).
 */
function extractLinkedIssueNumbers(pr: GitHubPR): number[] {
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
 * POST /api/projects/:name/issues/:num/start — Kick off oh-task for an issue.
 */
async function handleStartIssue(
  req: IncomingMessage,
  res: ServerResponse,
  projectName: string,
  issueNumber: string,
  authedUser: TelegramUser
): Promise<void> {
  const projectPath = await resolveProject(projectName);
  if (!projectPath) {
    json(res, 404, { error: `Project "${projectName}" not found` });
    return;
  }

  // Pull latest changes before starting (matches Telegram command behavior)
  try {
    await pullProject(projectPath);
  } catch {
    // Best-effort pull — continue even if it fails
  }

  // Parse optional body for baseBranch
  const body = await parseJsonBody<{ baseBranch?: string }>(req);
  const baseBranch = body?.baseBranch;
  // Use authenticated user's ID as chatId (private chat ID === user ID in Telegram)
  const chatId = authedUser.id;

  // Check for existing session
  const sessionKey = `oh-task-${projectName}-${issueNumber}`;
  const existing = getSession(sessionKey);
  if (existing) {
    json(res, 409, {
      error: `Session already exists for ${projectName} #${issueNumber}`,
      session: { taskId: existing.taskId, status: existing.status },
    });
    return;
  }

  try {
    const spawnOptions: SpawnOptions = { projectPath, projectName };
    if (baseBranch) {
      spawnOptions.baseBranch = baseBranch;
    }
    const sessionId = await spawnSession("oh-task", issueNumber, chatId, spawnOptions);

    const session: Session = {
      taskId: sessionKey,
      sessionId,
      skill: "oh-task",
      status: "running",
      startedAt: new Date(),
      chatId,
    };
    setSession(sessionKey, session);

    json(res, 201, {
      taskId: sessionKey,
      sessionId,
      issueNumber: parseInt(issueNumber, 10),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * POST /api/projects/:name/prs/:num/merge — Squash-merge a PR.
 */
async function handleMergePR(
  _req: IncomingMessage,
  res: ServerResponse,
  projectName: string,
  prNumber: string
): Promise<void> {
  const projectPath = await resolveProject(projectName);
  if (!projectPath) {
    json(res, 404, { error: `Project "${projectName}" not found` });
    return;
  }

  const num = parseInt(prNumber, 10);
  if (isNaN(num) || num <= 0) {
    json(res, 400, { error: "Invalid PR number" });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(projectPath);
    const result = await mergePR(owner, repo, num);

    if (result.merged) {
      json(res, 200, result);
    } else {
      json(res, 422, result);
    }
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      json(res, 429, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * POST /api/projects/:name/prs/:num/comment — Post a review comment on a PR.
 */
async function handleCommentPR(
  req: IncomingMessage,
  res: ServerResponse,
  projectName: string,
  prNumber: string
): Promise<void> {
  const projectPath = await resolveProject(projectName);
  if (!projectPath) {
    json(res, 404, { error: `Project "${projectName}" not found` });
    return;
  }

  const num = parseInt(prNumber, 10);
  if (isNaN(num) || num <= 0) {
    json(res, 400, { error: "Invalid PR number" });
    return;
  }

  const body = await parseJsonBody<{ body?: string }>(req);
  if (!body?.body || typeof body.body !== "string" || !body.body.trim()) {
    json(res, 400, { error: "Request body must include non-empty 'body' field" });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(projectPath);
    const result = await commentOnPR(owner, repo, num, body.body);
    json(res, 201, { id: result.id, url: result.html_url });
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      json(res, 429, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * GET /api/projects/:name/pr-enrichment — CI status and CodeRabbit review for all linked PRs.
 * Returns { enrichment: { [prNumber]: { ci, coderabbit } } }.
 * Results are cached 30s on the backend to avoid hammering GitHub API.
 */
async function handleGetPREnrichment(
  _req: IncomingMessage,
  res: ServerResponse,
  projectName: string
): Promise<void> {
  const projectPath = await resolveProject(projectName);
  if (!projectPath) {
    json(res, 404, { error: `Project "${projectName}" not found` });
    return;
  }

  try {
    const { owner, repo } = await getRepoInfo(projectPath);
    const [issues, prs] = await Promise.all([
      getOpenIssues(owner, repo),
      getOpenPRs(owner, repo),
    ]);

    // Find PRs linked to tracked issues (skip unrelated PRs)
    const linkedPRs: GitHubPR[] = [];
    for (const issue of issues) {
      const pr = findLinkedPR(prs, issue.number);
      if (pr && !linkedPRs.some((p) => p.number === pr.number)) {
        linkedPRs.push(pr);
      }
    }

    // Fetch enrichment for all linked PRs in parallel
    const enrichmentEntries = await Promise.all(
      linkedPRs.map(async (pr) => {
        try {
          const data = await getPREnrichment(owner, repo, pr);
          return [pr.number, data] as [number, PREnrichment];
        } catch (err) {
          // Best-effort: return a degraded result on error
          console.warn(`Failed to enrich PR #${pr.number}:`, err);
          return [pr.number, {
            ci: { state: "none" as const, checks: [] },
            coderabbit: { reviewed: false, state: null },
          }] as [number, PREnrichment];
        }
      })
    );

    const enrichment: Record<number, PREnrichment> = {};
    for (const [num, data] of enrichmentEntries) {
      enrichment[num] = data;
    }

    json(res, 200, { enrichment });
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      json(res, 429, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

/**
 * Route an API request to the appropriate handler.
 * Returns true if a route matched, false otherwise.
 */
export async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  const method = req.method ?? "GET";

  // Handle CORS preflight (no auth required)
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  // Only handle /api/* routes
  if (!pathname.startsWith("/api/")) return false;

  // All /api/* routes require Telegram initData authentication
  const authedUser = requireAuth(req, res);
  if (!authedUser) return true;

  // --- Existing routes ---

  if (pathname === "/api/sessions" && method === "GET") {
    handleGetSessions(req, res);
    return true;
  }

  if (pathname === "/api/projects" && method === "GET") {
    await handleGetProjects(req, res);
    return true;
  }

  // POST /api/sessions/:id/stop
  const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    await handleStopSession(req, res, decodeURIComponent(stopMatch[1]));
    return true;
  }

  // --- GitHub integration routes ---

  // GET /api/projects/:name/issues
  const issuesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/issues$/);
  if (issuesMatch && method === "GET") {
    await handleGetIssues(req, res, decodeURIComponent(issuesMatch[1]));
    return true;
  }

  // GET /api/projects/:name/prs
  const prsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/prs$/);
  if (prsMatch && method === "GET") {
    await handleGetPRs(req, res, decodeURIComponent(prsMatch[1]));
    return true;
  }

  // POST /api/projects/:name/issues/:num/start
  const startMatch = pathname.match(/^\/api\/projects\/([^/]+)\/issues\/(\d+)\/start$/);
  if (startMatch && method === "POST") {
    await handleStartIssue(req, res, decodeURIComponent(startMatch[1]), startMatch[2], authedUser);
    return true;
  }

  // POST /api/projects/:name/prs/:num/merge
  const mergeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/prs\/(\d+)\/merge$/);
  if (mergeMatch && method === "POST") {
    await handleMergePR(req, res, decodeURIComponent(mergeMatch[1]), mergeMatch[2]);
    return true;
  }

  // POST /api/projects/:name/prs/:num/comment
  const commentMatch = pathname.match(/^\/api\/projects\/([^/]+)\/prs\/(\d+)\/comment$/);
  if (commentMatch && method === "POST") {
    await handleCommentPR(req, res, decodeURIComponent(commentMatch[1]), commentMatch[2]);
    return true;
  }

  // GET /api/projects/:name/pr-enrichment
  const enrichMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pr-enrichment$/);
  if (enrichMatch && method === "GET") {
    await handleGetPREnrichment(req, res, decodeURIComponent(enrichMatch[1]));
    return true;
  }

  return false;
}
