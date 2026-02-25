// =============================================================================
// Portfolio Integration — wires portfolio state into Miranda's event flow.
//
// Triggers snapshot recomputation on:
// - Agent event (tool_execution_start/end, extension_ui_request, agent_end)
// - Session lifecycle (create, delete)
// - Scheduler poll completion
// - Overmind write-back
//
// High-priority events bypass debounce and publish immediately.
// =============================================================================

import { computeSnapshot } from "./state.js";
import { publishSnapshot, stopStream, flushPending } from "./stream.js";
import type { PortfolioState } from "./types.js";
import { setSessionLifecycleHook } from "../state/sessions.js";

// --- Last snapshot cache (used for SSE backfill on connect) -------------------

let lastSnapshot: PortfolioState | null = null;

export function getLastSnapshot(): PortfolioState | null {
  return lastSnapshot;
}

// --- Recompute & publish -----------------------------------------------------

/** Whether a recompute is already in-flight (prevent concurrent computations). */
let computing = false;
/** Whether another recompute was requested while one is in-flight. */
let pendingRecompute: { immediate: boolean } | null = null;

/**
 * Request a portfolio state recompute and publish to SSE subscribers.
 *
 * @param immediate - If true, bypasses SSE debounce (for high-priority events).
 */
export function requestRecompute(immediate = false): void {
  if (computing) {
    // Coalesce: if either the pending or new request is immediate, honor that.
    if (pendingRecompute) {
      pendingRecompute.immediate = pendingRecompute.immediate || immediate;
    } else {
      pendingRecompute = { immediate };
    }
    return;
  }

  doRecompute(immediate);
}

/** Consecutive failure counter for backoff. */
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

async function doRecompute(immediate: boolean): Promise<void> {
  computing = true;
  try {
    const snapshot = await computeSnapshot();
    lastSnapshot = snapshot;
    consecutiveFailures = 0;
    publishSnapshot(snapshot, immediate);
  } catch (err) {
    consecutiveFailures++;
    console.error(`[portfolio] Snapshot computation failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);
  } finally {
    computing = false;

    // Process any coalesced request (with backoff on repeated failures)
    if (pendingRecompute) {
      const { immediate: imm } = pendingRecompute;
      pendingRecompute = null;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[portfolio] Backing off after ${consecutiveFailures} consecutive failures`);
        consecutiveFailures = 0; // Reset so next external trigger can retry
      } else {
        doRecompute(imm);
      }
    }
  }
}

// --- Event hooks (called from agent/events.ts and scheduler) -----------------

/** High-priority events that should bypass SSE debounce. */
const HIGH_PRIORITY_EVENTS = new Set([
  "extension_ui_request",
  "agent_end",
  "extension_error",
]);

/**
 * Called when any agent RPC event is received.
 * Triggers a portfolio recompute.
 */
export function onAgentEvent(eventType: string): void {
  const immediate = HIGH_PRIORITY_EVENTS.has(eventType);
  requestRecompute(immediate);
}

/**
 * Called when a session is created or deleted.
 * Always triggers an immediate recompute.
 */
export function onSessionLifecycle(): void {
  requestRecompute(true);
}

/**
 * Called after a scheduler poll completes (GitHub data refreshed).
 * Normal priority — data changes are gradual.
 */
export function onSchedulerPoll(): void {
  requestRecompute(false);
}

/**
 * Called when the Overmind writes back data.
 * High priority — Overmind output should be reflected immediately.
 */
export function onOvermindUpdate(): void {
  requestRecompute(true);
}

// --- Lifecycle ---------------------------------------------------------------

let initialized = false;

/**
 * Initialize the portfolio module.
 * Computes the initial snapshot.
 * Called once during Miranda startup.
 */
export async function initPortfolio(): Promise<void> {
  if (initialized) return;
  initialized = true;

  console.log("   Portfolio: initializing...");

  // Register session lifecycle hook
  setSessionLifecycleHook(() => onSessionLifecycle());

  try {
    const snapshot = await computeSnapshot();
    lastSnapshot = snapshot;
    console.log(`   Portfolio: initial snapshot computed (_rev=${snapshot._rev})`);
  } catch (err) {
    console.error("   Portfolio: initial snapshot failed:", err);
  }
}

/**
 * Stop the portfolio module.
 * Flushes pending SSE data and closes all subscriber connections.
 */
export function stopPortfolio(): void {
  setSessionLifecycleHook(null);
  flushPending();
  stopStream();
  initialized = false;
  lastSnapshot = null;
  console.log("   Portfolio stopped");
}

// --- Re-exports for convenience ----------------------------------------------

export type { PortfolioState } from "./types.js";
export { addSubscriber, removeSubscriber, getSubscriberCount } from "./stream.js";
export { getOvermindState, setOvermindState, getAutomationConfig, setAutomationConfig, getAllAutomationConfigs } from "./state.js";
