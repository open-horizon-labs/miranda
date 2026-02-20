import type { IncomingMessage, ServerResponse } from "node:http";
import { getAllSessions, getSession, deleteSession } from "../state/sessions.js";
import { scanProjects } from "../projects/scanner.js";
import { stopSession } from "../bot/commands.js";

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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
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
 * Route an API request to the appropriate handler.
 * Returns true if a route matched, false otherwise.
 */
export async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  const method = req.method ?? "GET";

  // Handle CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

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

  return false;
}
