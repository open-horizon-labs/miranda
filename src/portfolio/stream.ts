// =============================================================================
// Portfolio SSE Stream — subscriber management with debounced publishing.
// =============================================================================

import type { ServerResponse } from "node:http";
import type { PortfolioState } from "./types.js";

// --- Subscriber management ---------------------------------------------------

const subscribers = new Set<ServerResponse>();

/** Add an SSE subscriber. Sends the current snapshot immediately if available. */
export function addSubscriber(res: ServerResponse, currentSnapshot: PortfolioState | null): void {
  subscribers.add(res);
  if (currentSnapshot) {
    writeSSE(res, currentSnapshot);
  }
}

/** Remove an SSE subscriber (on connection close). */
export function removeSubscriber(res: ServerResponse): void {
  subscribers.delete(res);
}

/** Get current subscriber count (for diagnostics). */
export function getSubscriberCount(): number {
  return subscribers.size;
}

// --- Publishing --------------------------------------------------------------

const NORMAL_DEBOUNCE_MS = 500;

/** Last published revision — skip publishing if unchanged. */
let lastPublishedRev = -1;

/** Debounce timer handle. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Pending snapshot waiting to be published (set during debounce window). */
let pendingSnapshot: PortfolioState | null = null;

/**
 * Publish a snapshot to all SSE subscribers.
 *
 * Normal events are debounced at 500ms — rapid state changes produce
 * one snapshot per debounce window.
 *
 * High-priority events (waiting_input, signal_completion, crash) bypass
 * debounce and publish immediately.
 */
export function publishSnapshot(snapshot: PortfolioState, immediate: boolean): void {
  if (subscribers.size === 0) return;

  if (immediate) {
    // Cancel any pending debounce — this supersedes it
    clearPending();
    broadcastSnapshot(snapshot);
  } else {
    // Debounce: store the latest snapshot and publish after the window
    pendingSnapshot = snapshot;
    if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (pendingSnapshot) {
          broadcastSnapshot(pendingSnapshot);
          pendingSnapshot = null;
        }
      }, NORMAL_DEBOUNCE_MS);
    }
  }
}

/** Force-flush any pending debounced snapshot. */
export function flushPending(): void {
  if (pendingSnapshot) {
    clearPending();
    broadcastSnapshot(pendingSnapshot);
    pendingSnapshot = null;
  }
}

// --- Internals ---------------------------------------------------------------

function clearPending(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function broadcastSnapshot(snapshot: PortfolioState): void {
  if (snapshot._rev === lastPublishedRev) return;
  lastPublishedRev = snapshot._rev;

  // Remove destroyed connections while iterating
  const dead: ServerResponse[] = [];
  for (const res of subscribers) {
    if (res.destroyed) {
      dead.push(res);
      continue;
    }
    writeSSE(res, snapshot);
  }
  for (const res of dead) {
    subscribers.delete(res);
  }
}

function writeSSE(res: ServerResponse, snapshot: PortfolioState): void {
  if (res.destroyed) return;
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
}

/** Clean up timers on shutdown. */
export function stopStream(): void {
  clearPending();
  pendingSnapshot = null;
  // Close all subscriber connections
  for (const res of subscribers) {
    if (!res.destroyed) {
      res.end();
    }
  }
  subscribers.clear();
}
