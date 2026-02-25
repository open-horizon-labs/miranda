import {
	fetchSessions,
	fetchProjects,
	fetchIssues,
	fetchPREnrichment,
	type SessionsResponse,
} from '../api/client.js';
import type {
	AppRegionData,
	AgentInfo,
	AgentStatus,
	AttentionItem,
	IssueInfo,
	Phase,
	PREnrichment,
} from '../types.js';

const POLL_INTERVAL = 5000;

type RawSession = SessionsResponse['sessions'][number];

function mapSessionStatus(status: string): AgentStatus {
	switch (status) {
		case 'starting':
			return 'starting';
		case 'running':
			return 'working';
		case 'waiting_input':
			return 'asking';
		case 'stopped':
			return 'done';
		case 'failed':
			return 'error';
		case 'blocked':
			return 'blocked';
		default:
			return 'working';
	}
}

function sessionToAgent(s: RawSession): AgentInfo {
	return {
		sessionId: s.sessionId,
		taskId: s.taskId,
		skill: s.skill,
		status: mapSessionStatus(s.status),
		startedAt: s.startedAt,
		elapsed: s.elapsed,
		pendingQuestion: s.pendingQuestion,
	};
}

/**
 * Extract issue number from a taskId.
 * Known formats:
 *   oh-task-<project>-<number>
 *   oh-ci-<project>-<number>
 *   oh-conflict-<project>-<number>
 *   oh-notes-<project>-<number>
 * Rejects timestamps and other numeric suffixes.
 */
function extractIssueNumber(taskId: string, projectName: string): number | null {
	// Match known skill prefixes that use issue numbers
	const skillPrefixes = ['oh-task', 'oh-ci', 'oh-conflict', 'oh-notes', 'oh-join'];
	for (const skill of skillPrefixes) {
		const prefix = `${skill}-${projectName}-`;
		if (taskId.startsWith(prefix)) {
			const rest = taskId.slice(prefix.length);
			const num = parseInt(rest, 10);
			// Only accept if the entire remainder is a number (no trailing chars)
			if (!Number.isNaN(num) && String(num) === rest) return num;
		}
	}
	return null;
}

function classifyIssue(issue: IssueInfo, agents: Map<number, AgentInfo>): Phase {
	// Closed issues are classified by their state, not by agent/PR presence.
	if (issue.state === 'closed') return 'done';
	// An open issue with a PR is in review; with an active agent is building.
	if (issue.pr) return 'review';
	if (agents.has(issue.number)) return 'building';
	return 'queued';
}

function buildAttentionItems(apps: AppRegionData[]): AttentionItem[] {
	const items: AttentionItem[] = [];

	for (const app of apps) {
		// Check agents in "asking" state
		for (const [issueNum, agent] of app.agents) {
			if (agent.status === 'asking') {
				const issue = findIssue(app, issueNum);
				items.push({
					id: `asking-${app.name}-${issueNum}`,
					project: app.name,
					issueNumber: issueNum,
					title: issue?.title ?? agent.taskId,
					reason: 'asking',
					agent,
					urgency: 1.0,
				});
			}
		}

		// Check PRs via enrichment
		for (const phase of Object.values(app.phases)) {
			for (const issue of phase) {
				if (!issue.pr) continue;
				const enrichment = app.enrichment[issue.pr.number];

				// CI failed
				if (enrichment?.ci.state === 'failure' || enrichment?.ci.state === 'error') {
					items.push({
						id: `ci-failed-${app.name}-${issue.number}`,
						project: app.name,
						issueNumber: issue.number,
						title: issue.title,
						reason: 'ci-failed',
						urgency: 0.8,
					});
				}

				// Merge conflicts
				if (issue.pr.mergeable === false) {
					items.push({
						id: `conflicts-${app.name}-${issue.number}`,
						project: app.name,
						issueNumber: issue.number,
						title: issue.title,
						reason: 'conflicts',
						urgency: 0.6,
					});
				}

				// Awaiting review: only flag when we have enrichment data to confirm state.
				// Without enrichment, we can't distinguish "not yet reviewed" from "data unavailable".
				if (
					enrichment &&
					issue.pr.state.toLowerCase() === 'open' &&
					enrichment.ci.state !== 'failure' &&
					enrichment.ci.state !== 'error' &&
					issue.pr.mergeable !== false &&
					!enrichment.coderabbit?.reviewed
				) {
					items.push({
						id: `review-needed-${app.name}-${issue.number}`,
						project: app.name,
						issueNumber: issue.number,
						title: issue.title,
						reason: 'review-needed',
						prUrl: issue.pr.url,
						urgency: 0.3,
					});
				}
			}
		}
	}

	items.sort((a, b) => b.urgency - a.urgency);
	return items;
}

function findIssue(app: AppRegionData, issueNumber: number): IssueInfo | undefined {
	for (const issues of Object.values(app.phases)) {
		const found = issues.find((i) => i.number === issueNumber);
		if (found) return found;
	}
	return undefined;
}

export class PortfolioStore {
	apps: AppRegionData[] = $state([]);
	attention: AttentionItem[] = $state([]);
	activeAgents: number = $state(0);
	totalCapacity: number = $state(5);
	lastUpdated: Date = $state(new Date());
	loading: boolean = $state(true);
	error: string | null = $state(null);
	doneToday: number = $state(0);

	private _interval: ReturnType<typeof setInterval> | null = null;
	private _refreshing = false;

	async refresh(): Promise<void> {
		if (this._refreshing) return;
		this._refreshing = true;

		try {
			const [projectsRes, sessionsRes] = await Promise.all([
				fetchProjects(),
				fetchSessions(),
			]);

			const agents = sessionsRes.sessions.map(sessionToAgent);

			// Build per-project data in parallel
			const appPromises = projectsRes.projects.map(async (proj) => {
				const [issuesRes, enrichmentRes] = await Promise.allSettled([
					fetchIssues(proj.name),
					fetchPREnrichment(proj.name),
				]);

				const issuesData =
					issuesRes.status === 'fulfilled' ? issuesRes.value : null;
				const issues = issuesData?.issues ?? [];
				const closedIssues = issuesData?.closedIssues ?? [];
				const repoUrl = issuesData?.repoUrl ?? '';
				const enrichment: Record<number, PREnrichment> =
					enrichmentRes.status === 'fulfilled'
						? (enrichmentRes.value.enrichment as Record<number, PREnrichment>)
						: {};

				// Match agents to issues in this project
				const agentMap = new Map<number, AgentInfo>();
				for (const agent of agents) {
					const issueNum = extractIssueNumber(agent.taskId, proj.name);
					if (issueNum !== null && issues.some((i) => i.number === issueNum)) {
						agentMap.set(issueNum, agent);
					}
				}

				// Classify open issues into phases
				const phases: Record<Phase, IssueInfo[]> = {
					queued: [],
					building: [],
					review: [],
					done: [],
				};

				for (const issue of issues) {
					const phase = classifyIssue(issue, agentMap);
					phases[phase].push(issue);
				}

				// Add closed issues to the done phase
				for (const closed of closedIssues) {
					phases.done.push({
						number: closed.number,
						title: closed.title,
						state: closed.state,
						labels: closed.labels,
						dependsOn: [],
						blockedBy: [],
						pr: null,
						closedAt: closed.closedAt ?? undefined,
					});
				}

				// Count issues closed today
				const todayStart = new Date();
				todayStart.setHours(0, 0, 0, 0);
				const todayMs = todayStart.getTime();
				const doneToday = closedIssues.filter((ci) => {
					if (!ci.closedAt) return false;
					return new Date(ci.closedAt).getTime() >= todayMs;
				}).length;

				return {
					name: proj.name,
					repoUrl,
					phases,
					agents: agentMap,
					enrichment,
					doneToday,
				} satisfies AppRegionData;
			});

			const apps = await Promise.all(appPromises);

			// Count active agents (not done, not error)
			const active = agents.filter(
				(a) => a.status !== 'done' && a.status !== 'error',
			).length;

			this.apps = apps;
			this.attention = buildAttentionItems(apps);
			this.activeAgents = active;
			this.doneToday = apps.reduce((sum, a) => sum + a.doneToday, 0);
			this.lastUpdated = new Date();
			this.loading = false;
			this.error = null;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			// Keep stale data; only clear loading on first successful fetch
			if (this.apps.length > 0) {
				this.loading = false;
			}
		} finally {
			this._refreshing = false;
		}
	}

	start(): void {
		if (this._interval) return;
		this.refresh();
		this._interval = setInterval(() => this.refresh(), POLL_INTERVAL);
	}

	stop(): void {
		if (this._interval) {
			clearInterval(this._interval);
			this._interval = null;
		}
	}
}

export const portfolio = new PortfolioStore();
