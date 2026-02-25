// =============================================================================
// Mechanical Attention — pure functions deriving attention items from state.
// Each function inspects a specific failure mode and produces an AttentionItem
// if the condition is detected.
// =============================================================================

import type { Session } from "../types.js";
import type { AppState, AttentionItem } from "./types.js";

/** Threshold for considering an agent session stale (no tool activity). */
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Derive all mechanical attention items from current sessions and app state.
 * Pure function — no side effects, no I/O.
 */
export function deriveAttention(sessions: Session[], apps: AppState[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = Date.now();

  // Session-level attention
  for (const session of sessions) {
    // question — agent has pendingQuestion or pendingUIRequestId
    if (session.pendingQuestion || session.pendingUIRequestId) {
      items.push({
        type: "question",
        target: session.taskId,
        summary: session.pendingQuestion
          ? `Agent needs input: ${session.pendingQuestion.questions[0]?.question ?? "unknown"}`
          : "Agent needs UI response",
        urgency: "high",
        actions: [],
        context: {
          sessionKey: session.taskId,
          sessionId: session.sessionId,
          receivedAt: session.pendingQuestion?.receivedAt?.toISOString() ?? null,
        },
      });
    }

    // stale_session — agent.lastToolActivityAt older than STALE_THRESHOLD
    if (
      session.status === "running" &&
      session.lastToolActivityAt &&
      now - session.lastToolActivityAt.getTime() > STALE_THRESHOLD_MS
    ) {
      const staleMins = Math.floor((now - session.lastToolActivityAt.getTime()) / 60000);
      items.push({
        type: "stale_session",
        target: session.taskId,
        summary: `Agent idle for ${staleMins}m (no tool activity)`,
        urgency: "medium",
        actions: [
          {
            label: "Stop",
            route: `/api/sessions/${encodeURIComponent(session.taskId)}/stop`,
            method: "POST",
          },
        ],
        context: {
          sessionKey: session.taskId,
          sessionId: session.sessionId,
          lastToolActivityAt: session.lastToolActivityAt.toISOString(),
          staleMinutes: staleMins,
        },
      });
    }
  }

  // App-level attention (from computed issue/PR state)
  for (const app of apps) {
    for (const phase of app.phases) {
      for (const issue of phase.issueDetails) {
        // ci_failure — PR CI status failing
        if (issue.pr && issue.pr.ci === "failure") {
          items.push({
            type: "ci_failure",
            target: `PR #${issue.pr.number}`,
            summary: `CI failing on PR #${issue.pr.number} (${issue.pr.title})`,
            urgency: "high",
            actions: [
              {
                label: "Fix CI",
                route: `/api/projects/${encodeURIComponent(app.project)}/prs/${issue.pr.number}/fix-ci`,
                method: "POST",
              },
            ],
            context: {
              project: app.project,
              app: app.name,
              issueNumber: issue.number,
              prNumber: issue.pr.number,
            },
          });
        }

        // merge_conflict — PR has conflicts
        if (issue.pr && issue.pr.hasConflicts) {
          items.push({
            type: "merge_conflict",
            target: `PR #${issue.pr.number}`,
            summary: `Merge conflicts on PR #${issue.pr.number} (${issue.pr.title})`,
            urgency: "high",
            actions: [
              {
                label: "Resolve Conflicts",
                route: `/api/projects/${encodeURIComponent(app.project)}/prs/${issue.pr.number}/fix-conflicts`,
                method: "POST",
              },
            ],
            context: {
              project: app.project,
              app: app.name,
              issueNumber: issue.number,
              prNumber: issue.pr.number,
            },
          });
        }
      }
    }
  }

  return items;
}
