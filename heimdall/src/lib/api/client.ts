/**
 * Resolve Miranda API base URL at runtime.
 * Priority: env var (build time) > same-origin fallback > localhost default.
 *
 * Note: Miranda's API requires Telegram initData auth for mutation endpoints.
 * The surface currently calls read-only endpoints without auth, which works
 * when Miranda is configured to allow unauthenticated reads (local/dev mode).
 * For production, add auth token handling here.
 */
function getBaseUrl(): string {
	const envUrl = import.meta.env.VITE_MIRANDA_API_URL;
	if (envUrl) return envUrl;
	if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
		return window.location.origin;
	}
	return 'http://localhost:3000';
}

const BASE_URL = getBaseUrl();
// --- Response types (mirror API shape) ---

export interface SessionsResponse {
	sessions: Array<{
		taskId: string;
		sessionId: string;
		skill: string;
		status: string;
		startedAt: string;
		elapsed: string;
		pendingQuestion: {
			messageId: number;
			questions: string[];
			receivedAt: string;
		} | null;
	}>;
}

export interface ProjectsResponse {
	projects: Array<{
		name: string;
		path: string;
		openCount: number;
		inProgressCount: number;
	}>;
}

export interface IssuesResponse {
	repoUrl: string;
	issues: Array<{
		number: number;
		title: string;
		state: string;
		labels: string[];
		dependsOn: number[];
		blockedBy: number[];
		pr: {
			number: number;
			state: string;
			mergeable: boolean | null;
			url: string;
		} | null;
	}>;
	closedIssues: Array<{
		number: number;
		title: string;
		state: string;
		labels: string[];
		closedAt: string | null;
	}>;
}

export interface PRsResponse {
	prs: Array<{
		number: number;
		title: string;
		state: string;
		mergeable: boolean | null;
		url: string;
		base: string;
		head: string;
		linkedIssues: number[];
	}>;
}

export interface AllPRsResponse {
	prs: Array<{
		project: string;
		number: number;
		title: string;
		state: string;
		mergeable: boolean | null;
		url: string;
		base: string;
		head: string;
		linkedIssues: number[];
		enrichment: {
			ci: { state: string; checks: Array<{ name: string; status: string; conclusion: string | null }> };
			coderabbit: { reviewed: boolean; state: string | null };
		} | null;
		mergeStateStatus: string | null;
		behindBy: number;
	}>;
}

export interface EnrichmentResponse {
	enrichment: Record<number, {
		ci: { state: string; checks: Array<{ name: string; status: string; conclusion: string | null }> };
		coderabbit: { reviewed: boolean; state: string | null };
	}>;
}

export interface MergeResponse {
	merged: boolean;
	message: string;
	sha?: string;
}

// --- Client ---

class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly statusText: string,
		public readonly body: string,
	) {
		super(`API ${status} ${statusText}: ${body}`);
		this.name = 'ApiError';
	}
}

export { ApiError };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const url = `${BASE_URL}${path}`;
	const res = await fetch(url, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...init?.headers,
		},
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new ApiError(res.status, res.statusText, body);
	}

	// Handle empty bodies (some POST endpoints return 204 or empty 200)
	const text = await res.text();
	if (!text) return undefined as T;
	return JSON.parse(text) as T;
}

// --- Endpoint functions ---

export function fetchSessions(): Promise<SessionsResponse> {
	return request<SessionsResponse>('/api/sessions');
}

export function fetchProjects(): Promise<ProjectsResponse> {
	return request<ProjectsResponse>('/api/projects');
}

export function fetchIssues(project: string): Promise<IssuesResponse> {
	return request<IssuesResponse>(`/api/projects/${encodeURIComponent(project)}/issues`);
}

export function fetchPRs(project: string): Promise<PRsResponse> {
	return request<PRsResponse>(`/api/projects/${encodeURIComponent(project)}/prs`);
}

export function fetchAllPRs(): Promise<AllPRsResponse> {
	return request<AllPRsResponse>('/api/prs');
}

export function fetchPREnrichment(project: string): Promise<EnrichmentResponse> {
	return request<EnrichmentResponse>(`/api/projects/${encodeURIComponent(project)}/pr-enrichment`);
}

export async function stopSession(taskId: string): Promise<void> {
	await request<void>(`/api/sessions/${encodeURIComponent(taskId)}/stop`, {
		method: 'POST',
	});
}

export function mergePR(project: string, prNumber: number): Promise<MergeResponse> {
	return request<MergeResponse>(
		`/api/projects/${encodeURIComponent(project)}/prs/${prNumber}/merge`,
		{ method: 'POST' },
	);
}
