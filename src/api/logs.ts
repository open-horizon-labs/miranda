import type { ServerResponse } from "node:http";

// ============================================================================
// SSE Log Streaming — Per-session subscriber management with ring buffer
// ============================================================================

export interface LogEvent {
  type: "tool_start" | "tool_end" | "text" | "question" | "complete" | "error";
  tool?: string;
  content?: string;
  time: string; // HH:MM:SS
}

const BUFFER_SIZE = 50;

/** Per-session subscriber set */
const subscribers = new Map<string, Set<ServerResponse>>();

/** Ring buffer of last N events per session for backfill on connect */
const eventBuffers = new Map<string, LogEvent[]>();

/** Text delta throttle state per session */
interface ThrottleState {
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
}
const textThrottles = new Map<string, ThrottleState>();

const TEXT_THROTTLE_MS = 200;

/**
 * Format current time as HH:MM:SS.
 */
function timeNow(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

/**
 * Write a single SSE event to a response stream.
 */
function writeSSE(res: ServerResponse, event: LogEvent): void {
  if (res.destroyed) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Append event to ring buffer for a session.
 */
function bufferEvent(sessionId: string, event: LogEvent): void {
  let buf = eventBuffers.get(sessionId);
  if (!buf) {
    buf = [];
    eventBuffers.set(sessionId, buf);
  }
  buf.push(event);
  if (buf.length > BUFFER_SIZE) {
    buf.shift();
  }
}

/**
 * Flush any pending throttled text for a session immediately.
 */
function flushTextThrottle(sessionId: string): void {
  const state = textThrottles.get(sessionId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.pending) {
    const event: LogEvent = { type: "text", content: state.pending, time: timeNow() };
    state.pending = "";
    bufferEvent(sessionId, event);
    const subs = subscribers.get(sessionId);
    if (subs) {
      for (const res of subs) {
        writeSSE(res, event);
      }
    }
  }
  textThrottles.delete(sessionId);
}

/**
 * Called from handleAgentEvent to fan-out log events to SSE subscribers.
 * Text deltas are throttled: batched and emitted at most once per 200ms.
 */
export function emitLogEvent(sessionId: string, event: LogEvent): void {
  // Text deltas get throttled
  if (event.type === "text") {
    let state = textThrottles.get(sessionId);
    if (!state) {
      state = { pending: "", timer: null };
      textThrottles.set(sessionId, state);
    }
    state.pending += event.content ?? "";
    if (!state.timer) {
      state.timer = setTimeout(() => {
        flushTextThrottle(sessionId);
      }, TEXT_THROTTLE_MS);
    }
    return;
  }

  // Non-text events: flush any pending text first, then emit immediately
  flushTextThrottle(sessionId);

  bufferEvent(sessionId, event);
  const subs = subscribers.get(sessionId);
  if (!subs) return;
  for (const res of subs) {
    writeSSE(res, event);
  }
}

/**
 * Subscribe a response to a session's log stream.
 * Sends backfill events from ring buffer immediately.
 */
export function subscribe(sessionId: string, res: ServerResponse): void {
  let subs = subscribers.get(sessionId);
  if (!subs) {
    subs = new Set();
    subscribers.set(sessionId, subs);
  }
  subs.add(res);

  // Send backfill
  const buf = eventBuffers.get(sessionId);
  if (buf) {
    for (const event of buf) {
      writeSSE(res, event);
    }
  }
}

/**
 * Unsubscribe a response (on connection close).
 */
export function unsubscribe(sessionId: string, res: ServerResponse): void {
  const subs = subscribers.get(sessionId);
  if (!subs) return;
  subs.delete(res);
  if (subs.size === 0) {
    subscribers.delete(sessionId);
  }
}

/**
 * Clean up when session ends — flush pending text, notify subscribers, remove state.
 */
export function closeSession(sessionId: string): void {
  flushTextThrottle(sessionId);
  textThrottles.delete(sessionId);
  eventBuffers.delete(sessionId);
  const subs = subscribers.get(sessionId);
  if (subs) {
    for (const res of subs) {
      if (!res.destroyed) {
        res.end();
      }
    }
    subscribers.delete(sessionId);
  }
}
