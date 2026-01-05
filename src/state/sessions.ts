import type { Session } from "../types.js";

// AIDEV-NOTE: In-memory for MVP. Phase 4 moves to SQLite for persistence.
const sessions = new Map<string, Session>();

export function getSession(taskId: string): Session | undefined {
  return sessions.get(taskId);
}

export function setSession(taskId: string, session: Session): void {
  sessions.set(taskId, session);
}

export function deleteSession(taskId: string): boolean {
  return sessions.delete(taskId);
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

export function findSessionByTmuxName(tmuxName: string): Session | undefined {
  for (const session of sessions.values()) {
    if (session.tmuxName === tmuxName) {
      return session;
    }
  }
  return undefined;
}

export function findSessionAwaitingInput(): Session[] {
  return getAllSessions().filter((s) => s.status === "waiting_input");
}
