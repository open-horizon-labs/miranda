import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GITHUB_API = "https://api.github.com";

/** Cached owner/repo per project path. */
const repoInfoCache = new Map<string, { owner: string; repo: string }>();

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  body: string | null;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  /** Whether the PR can be merged (no conflicts). */
  mergeable: boolean | null;
  html_url: string;
  /** Branch the PR merges into. */
  base: string;
  /** Branch the PR is from. */
  head: string;
  body: string | null;
  /** SHA of the PR head commit (for CI status lookups). */
  headSha: string;
}

export interface GitHubMergeResult {
  merged: boolean;
  message: string;
  sha?: string;
}

/**
 * Get the GitHub token from environment.
 * Uses GITHUB_TOKEN (standard for gh CLI and CI).
 */
function getToken(): string {
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return token;
}

/**
 * Make an authenticated GitHub API request.
 * Throws on non-2xx responses with the error message from GitHub.
 * Returns parsed JSON.
 */
async function githubFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
  } = {}
): Promise<T> {
  const token = options.token ?? getToken();
  const method = options.method ?? "GET";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "miranda-bot",
  };

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, init);

  // Check rate limiting
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null && parseInt(remaining, 10) === 0) {
    const resetAt = res.headers.get("x-ratelimit-reset");
    const resetDate = resetAt ? new Date(parseInt(resetAt, 10) * 1000).toISOString() : "unknown";
    throw new GitHubRateLimitError(`GitHub API rate limit exhausted. Resets at ${resetDate}`);
  }

  if (!res.ok) {
    let errorMessage: string;
    try {
      const errorBody = (await res.json()) as { message?: string };
      errorMessage = errorBody.message ?? res.statusText;
    } catch {
      errorMessage = res.statusText;
    }
    throw new Error(`GitHub API ${method} ${path}: ${res.status} ${errorMessage}`);
  }

  // 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/**
 * Detect owner/repo from git remote in a project directory.
 * Parses the origin remote URL (HTTPS or SSH format).
 * Results are cached per project path.
 */
export async function getRepoInfo(projectPath: string): Promise<{ owner: string; repo: string }> {
  const cached = repoInfoCache.get(projectPath);
  if (cached) return cached;

  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd: projectPath,
  });
  const url = stdout.trim();

  // Parse HTTPS: https://github.com/owner/repo.git
  // Parse SSH: git@github.com:owner/repo.git
  let match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) {
    // Try generic patterns
    match = url.match(/[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  }
  if (!match) {
    throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`);
  }

  const info = { owner: match[1], repo: match[2] };
  repoInfoCache.set(projectPath, info);
  return info;
}

/**
 * Fetch all open issues for a repository.
 * Paginates automatically (100 per page).
 */
export async function getOpenIssues(
  owner: string,
  repo: string
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;

  while (true) {
    // GitHub's issues endpoint includes PRs — filter them out by checking pull_request field
    const raw = await githubFetch<Array<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      body: string | null;
      pull_request?: unknown;
    }>>(`/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`);

    if (raw.length === 0) break;

    for (const item of raw) {
      // Skip pull requests (GitHub includes them in issues endpoint)
      if (item.pull_request) continue;

      issues.push({
        number: item.number,
        title: item.title,
        state: item.state,
        labels: item.labels.map((l) => l.name),
        body: item.body,
      });
    }

    if (raw.length < 100) break;
    page++;
  }

  return issues;
}

/**
 * Fetch all open PRs for a repository.
 * Paginates automatically.
 */
export async function getOpenPRs(
  owner: string,
  repo: string
): Promise<GitHubPR[]> {
  const prs: GitHubPR[] = [];
  let page = 1;

  while (true) {
    const raw = await githubFetch<Array<{
      number: number;
      title: string;
      state: string;
      mergeable: boolean | null;
      html_url: string;
      base: { ref: string };
      head: { ref: string; sha: string };
      body: string | null;
    }>>(`/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`);

    if (raw.length === 0) break;

    for (const item of raw) {
      prs.push({
        number: item.number,
        title: item.title,
        state: item.state,
        mergeable: item.mergeable,
        html_url: item.html_url,
        base: item.base.ref,
        head: item.head.ref,
        headSha: item.head.sha,
        body: item.body,
      });
    }

    if (raw.length < 100) break;
    page++;
  }

  // List endpoint returns mergeable: null — hydrate from individual PR fetches
  await Promise.all(
    prs.map(async (pr) => {
      try {
        const detail = await githubFetch<{ mergeable: boolean | null }>(
          `/repos/${owner}/${repo}/pulls/${pr.number}`
        );
        pr.mergeable = detail.mergeable;
      } catch {
        // Best-effort — leave as null
      }
    })
  );

  return prs;
}

/**
 * Squash-merge a pull request.
 */
export async function mergePR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubMergeResult> {
  try {
    const result = await githubFetch<{
      merged: boolean;
      message: string;
      sha: string;
    }>(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: { merge_method: "squash" },
    });
    return { merged: result.merged, message: result.message, sha: result.sha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { merged: false, message };
  }
}

/**
 * Close a GitHub issue.
 */
export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{ closed: boolean; message: string }> {
  try {
    await githubFetch<{ state: string }>(
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        body: { state: "closed" },
      }
    );
    return { closed: true, message: "Issue closed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { closed: false, message };
  }
}

/**
 * Post a comment on a PR (or issue — same API).
 */
export async function commentOnPR(
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<{ id: number; html_url: string }> {
  return githubFetch<{ id: number; html_url: string }>(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      body: { body },
    }
  );
}

/**
 * Find PRs linked to a specific issue number.
 *
 * Checks:
 * 1. PR branch name contains `issue-N` or `issue/N`
 * 2. PR body contains `Closes #N`, `Fixes #N`, or `Resolves #N`
 */
export function findLinkedPR(
  prs: GitHubPR[],
  issueNumber: number
): GitHubPR | null {
  const issueStr = String(issueNumber);

  for (const pr of prs) {
    // Check branch name patterns: issue-N, issue/N, N-description
    const branchPatterns = [
      new RegExp(`issue[/-]${issueStr}(?:\\b|$)`),
      new RegExp(`^${issueStr}-`),
    ];
    if (branchPatterns.some((p) => p.test(pr.head))) {
      return pr;
    }

    // Check PR body for closing references
    if (pr.body) {
      const closingPattern = new RegExp(
        `(?:closes|fixes|resolves)\\s+#${issueStr}\\b`,
        "i"
      );
      if (closingPattern.test(pr.body)) {
        return pr;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CI Status + CodeRabbit review enrichment
// ---------------------------------------------------------------------------

export interface CICheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CIStatus {
  /** Overall state: "success" | "failure" | "pending" | "none". */
  state: "success" | "failure" | "pending" | "none";
  checks: CICheck[];
}

export interface CodeRabbitStatus {
  reviewed: boolean;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | null;
}

export interface PREnrichment {
  ci: CIStatus;
  coderabbit: CodeRabbitStatus;
}

/** Simple TTL cache entry. */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const ENRICHMENT_TTL_MS = 30_000; // 30 seconds
const enrichmentCache = new Map<string, CacheEntry<PREnrichment>>();

/**
 * Fetch CI status for a commit SHA.
 * Combines the legacy combined status endpoint with check runs.
 */
async function fetchCIStatus(
  owner: string,
  repo: string,
  sha: string
): Promise<CIStatus> {
  const [combinedStatus, checkRuns] = await Promise.all([
    githubFetch<{
      state: string;
      statuses: Array<{ context: string; state: string }>;
    }>(`/repos/${owner}/${repo}/commits/${sha}/status`),
    githubFetch<{
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;
    }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs`),
  ]);

  const checks: CICheck[] = checkRuns.check_runs.map((cr) => ({
    name: cr.name,
    status: cr.status,
    conclusion: cr.conclusion,
  }));

  // Also include legacy statuses as checks
  for (const s of combinedStatus.statuses) {
    // Avoid duplicates if a status also appears as a check run
    if (!checks.some((c) => c.name === s.context)) {
      checks.push({
        name: s.context,
        status: "completed",
        conclusion: s.state === "success" ? "success" : s.state === "failure" ? "failure" : s.state,
      });
    }
  }

  // Determine overall state
  if (checks.length === 0) {
    return { state: "none", checks };
  }

  const hasFailure = checks.some(
    (c) => c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out"
  );
  if (hasFailure) {
    return { state: "failure", checks };
  }

  const allComplete = checks.every((c) => c.status === "completed");
  const allSuccess = checks.every(
    (c) => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral"
  );
  if (allComplete && allSuccess) {
    return { state: "success", checks };
  }

  return { state: "pending", checks };
}

/**
 * Fetch CodeRabbit review status for a PR.
 * Looks for reviews where user.login contains "coderabbit" (case-insensitive).
 */
async function fetchCodeRabbitReview(
  owner: string,
  repo: string,
  prNumber: number
): Promise<CodeRabbitStatus> {
  const reviews = await githubFetch<Array<{
    user: { login: string } | null;
    state: string;
  }>>(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);

  // Filter for CodeRabbit reviews
  const coderabbitReviews = reviews.filter(
    (r) => r.user?.login?.toLowerCase().includes("coderabbit")
  );

  if (coderabbitReviews.length === 0) {
    return { reviewed: false, state: null };
  }

  // Use the most recent CodeRabbit review state
  const latestState = coderabbitReviews[coderabbitReviews.length - 1].state;
  const normalizedState = latestState as CodeRabbitStatus["state"];
  return { reviewed: true, state: normalizedState };
}

/**
 * Get enrichment data (CI + CodeRabbit) for a single PR.
 * Results are cached for 30 seconds.
 */
export async function getPREnrichment(
  owner: string,
  repo: string,
  pr: GitHubPR
): Promise<PREnrichment> {
  const cacheKey = `${owner}/${repo}/${pr.number}/${pr.headSha}`;
  const now = Date.now();

  const cached = enrichmentCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const [ci, coderabbit] = await Promise.all([
    fetchCIStatus(owner, repo, pr.headSha),
    fetchCodeRabbitReview(owner, repo, pr.number),
  ]);

  const enrichment: PREnrichment = { ci, coderabbit };
  enrichmentCache.set(cacheKey, { data: enrichment, expiresAt: now + ENRICHMENT_TTL_MS });

  // Prune expired entries periodically (every 50 writes)
  if (enrichmentCache.size > 50) {
    for (const [key, entry] of enrichmentCache) {
      if (entry.expiresAt <= now) {
        enrichmentCache.delete(key);
      }
    }
  }

  return enrichment;
}

export interface MergedPR {
	number: number;
	title: string;
	html_url: string;
	merged_at: string;
	head: string;
	body: string | null;
}

/**
 * Fetch PRs merged since a given date.
 * Paginates through closed PRs sorted by updated desc, stopping when
 * all remaining PRs were last updated before `since`.
 */
export async function getMergedPRsSince(
	owner: string,
	repo: string,
	since: Date
): Promise<MergedPR[]> {
	const result: MergedPR[] = [];
	const sinceTime = since.getTime();
	let page = 1;

	while (true) {
		const raw = await githubFetch<Array<{
			number: number;
			title: string;
			html_url: string;
			merged_at: string | null;
			updated_at: string;
			head: { ref: string };
			body: string | null;
		}>>(
			`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`
		);

		if (raw.length === 0) break;

		let seenOlder = false;
		for (const item of raw) {
			// Sorted by updated desc — once we hit one updated before since, all remaining are older
			if (new Date(item.updated_at).getTime() < sinceTime) {
				seenOlder = true;
				break;
			}

			// Skip closed-but-not-merged PRs
			if (!item.merged_at) continue;

			// Only include if actually merged at or after since
			if (new Date(item.merged_at).getTime() >= sinceTime) {
				result.push({
					number: item.number,
					title: item.title,
					html_url: item.html_url,
					merged_at: item.merged_at,
					head: item.head.ref,
					body: item.body,
				});
			}
		}

		if (seenOlder || raw.length < 100) break;
		page++;
	}

	return result;
}