import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../types.js";

// AIDEV-NOTE: In-memory for MVP. Phase 4 moves to SQLite for persistence.
const sessions = new Map<string, Session>();

// File path for restart chat ID persistence (survives process restart)
const RESTART_CHAT_ID_FILE = join(tmpdir(), "miranda-restart-chat-id");

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

// Restart chat ID management (persisted to file to survive process restart)
export function setRestartChatId(chatId: number): void {
  try {
    // Store chatId:timestamp format so we can detect stale files
    const content = `${chatId}:${Date.now()}`;
    writeFileSync(RESTART_CHAT_ID_FILE, content, "utf-8");
  } catch {
    // Best effort - if we can't write the file, "back online" message won't be sent
  }
}

export function getRestartChatId(): number | null {
  try {
    const content = readFileSync(RESTART_CHAT_ID_FILE, "utf-8").trim();
    // File format: "chatId:timestamp"
    const [chatIdStr, timestampStr] = content.split(":");
    const chatId = parseInt(chatIdStr, 10);
    const timestamp = parseInt(timestampStr, 10);

    if (isNaN(chatId)) return null;
    if (isNaN(timestamp)) return null;

    // Only accept if file was written within last 60 seconds (fresh restart)
    // This prevents spurious "back online" messages after crashes
    const age = Date.now() - timestamp;
    if (age > 60_000) {
      return null;
    }

    return chatId;
  } catch {
    return null;
  }
}

export function clearRestartChatId(): void {
  try {
    unlinkSync(RESTART_CHAT_ID_FILE);
  } catch {
    // File may not exist, that's fine
  }
}
