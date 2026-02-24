export interface DependencyNode {
	issueNumber: number;
	title: string;
	dependsOn: number[];
	dependedBy: number[];
}

export interface DependencyGraph {
	nodes: Map<number, DependencyNode>;
}

export function buildDependencyGraph(
	issues: Array<{ number: number; title: string; dependsOn: number[] }>,
): DependencyGraph {
	const nodes = new Map<number, DependencyNode>();

	const getOrCreate = (num: number): DependencyNode => {
		let node = nodes.get(num);
		if (!node) {
			node = { issueNumber: num, title: "", dependsOn: [], dependedBy: [] };
			nodes.set(num, node);
		}
		return node;
	};

	for (const issue of issues) {
		const node = getOrCreate(issue.number);
		node.title = issue.title;
		node.dependsOn = issue.dependsOn;

		for (const dep of issue.dependsOn) {
			const depNode = getOrCreate(dep);
			depNode.dependedBy.push(issue.number);
		}
	}

	return { nodes };
}

export function findUnblockedIssues(
	graph: DependencyGraph,
	openIssueNumbers: Set<number>,
	resolvedIssueNumbers: Set<number>,
): number[] {
	const unblocked: number[] = [];

	for (const [num, node] of graph.nodes) {
		if (!openIssueNumbers.has(num)) continue;
		if (node.dependsOn.length === 0) continue;
		if (node.dependsOn.every((dep) => resolvedIssueNumbers.has(dep) || !openIssueNumbers.has(dep))) {
			unblocked.push(num);
		}
	}

	return unblocked;
}

/** An issue that can be started stacked on a dep's PR branch. */
export interface StackUnblocked {
	issueNumber: number;
	/** The single unmerged dep whose branch becomes --base. */
	baseDep: number;
}

/**
 * Find issues eligible to start stacked on an unmerged dep's PR branch.
 *
 * An issue is stack-unblocked when:
 * - It is open
 * - It has dependencies
 * - ALL deps are either fully resolved (closed/merged) or stack-ready
 * - Exactly ONE dep is stack-ready (not merged, but PR is green + reviewed)
 *   This avoids the diamond problem where we'd need to merge two branches.
 *
 * @param stackReadyIssues - issue numbers whose PR is green, CR approved, and session finished
 */
export function findStackUnblockedIssues(
	graph: DependencyGraph,
	openIssueNumbers: Set<number>,
	resolvedIssueNumbers: Set<number>,
	stackReadyIssues: Set<number>,
): StackUnblocked[] {
	const result: StackUnblocked[] = [];

	for (const [num, node] of graph.nodes) {
		if (!openIssueNumbers.has(num)) continue;
		if (node.dependsOn.length === 0) continue;

		let allSatisfied = true;
		const stackReadyDeps: number[] = [];

		for (const dep of node.dependsOn) {
			const resolved = resolvedIssueNumbers.has(dep) || !openIssueNumbers.has(dep);
			const stackReady = stackReadyIssues.has(dep);

			if (resolved) {
				// Dep is fully merged/closed — fine
				continue;
			} else if (stackReady) {
				stackReadyDeps.push(dep);
			} else {
				allSatisfied = false;
				break;
			}
		}

		// Exactly one unmerged dep is stack-ready, all others are resolved
		if (allSatisfied && stackReadyDeps.length === 1) {
			result.push({ issueNumber: num, baseDep: stackReadyDeps[0] });
		}
	}

	return result;
}

export function detectCycles(graph: DependencyGraph): number[][] {
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;

	const color = new Map<number, number>();
	for (const num of graph.nodes.keys()) {
		color.set(num, WHITE);
	}

	const cycles: number[][] = [];
	const stack: number[] = [];

	const dfs = (u: number): void => {
		color.set(u, GRAY);
		stack.push(u);

		const node = graph.nodes.get(u)!;
		for (const v of node.dependsOn) {
			const c = color.get(v);
			if (c === undefined) continue; // Dependency not in graph (closed/external)
			if (c === GRAY) {
				// Found cycle — extract from stack
				const idx = stack.indexOf(v);
				cycles.push(stack.slice(idx));
			} else if (c === WHITE) {
				dfs(v);
			}
		}

		stack.pop();
		color.set(u, BLACK);
	};

	for (const num of graph.nodes.keys()) {
		if (color.get(num) === WHITE) {
			dfs(num);
		}
	}

	return cycles;
}

// ---------------------------------------------------------------------------
// Factory phase labels
// ---------------------------------------------------------------------------

/** Ordered standard factory phases. Lower index = earlier phase. */
const STANDARD_PHASE_ORDER: readonly string[] = ["build", "audit", "critique"];

export interface FactoryPhase {
	app: string;
	phase: string;
	phaseIndex: number;
}

/**
 * Parse a factory phase label.
 * Labels follow the pattern `factory:<app>:<phase>` (e.g., `factory:dm:audit`).
 * Returns null if the label is not a factory phase label.
 */
export function parseFactoryLabel(label: string): FactoryPhase | null {
	const parts = label.split(":");
	if (parts.length !== 3 || parts[0] !== "factory") return null;
	const [, app, phase] = parts;
	const phaseIndex = STANDARD_PHASE_ORDER.indexOf(phase);
	if (phaseIndex === -1) return { app, phase, phaseIndex: -1 };
	return { app, phase, phaseIndex };
}

/**
 * Find the factory phase for an issue from its labels.
 * Returns null if the issue has no factory phase label.
 */
export function getIssueFactoryPhase(labels: string[]): FactoryPhase | null {
	for (const label of labels) {
		const phase = parseFactoryLabel(label);
		if (phase) return phase;
	}
	return null;
}

/** Reason a candidate was blocked by the factory phase gate. */
export interface FactoryPhaseRejection {
	issue: number;
	app: string;
	phase: string;
	blockedByPhase: string;
	blockerIssues: number[];
}

export interface FactoryPhaseFilterResult {
	passed: StackUnblocked[];
	rejected: FactoryPhaseRejection[];
}

/**
 * Filter stack-unblocked issues by factory phase ordering.
 *
 * An issue in phase N is blocked if there are ANY open, NOT-stack-ready issues in
 * an earlier phase (< N) for the same factory app.
 *
 * This handles the evaluation-loop pattern: critique (phase 2) is
 * blocked until ALL audit-phase issues (phase 1) — including
 * dynamically spawned fix issues — are resolved.
 *
 * Non-factory issues pass through unchanged.
 */
export function filterByFactoryPhase(
	candidates: StackUnblocked[],
	allIssues: Array<{ number: number; labels: string[] }>,
	openIssueNumbers: Set<number>,
	stackReadyIssues: Set<number> = new Set(),
): FactoryPhaseFilterResult {
	// Build a map: factory app → phase index → set of open issue numbers
	const phaseMap = new Map<string, Map<number, Set<number>>>();

	for (const issue of allIssues) {
		if (!openIssueNumbers.has(issue.number)) continue;
		if (stackReadyIssues.has(issue.number)) continue; // ready issues do not block later phases
		const fp = getIssueFactoryPhase(issue.labels);
		if (!fp) continue;

		let appPhases = phaseMap.get(fp.app);
		if (!appPhases) {
			appPhases = new Map();
			phaseMap.set(fp.app, appPhases);
		}
		if (fp.phaseIndex < 0) continue; // custom phases don't participate in phase gating
		let issueSet = appPhases.get(fp.phaseIndex);
		if (!issueSet) {
			issueSet = new Set();
			appPhases.set(fp.phaseIndex, issueSet);
		}
		issueSet.add(issue.number);
	}

	// Filter candidates: block if earlier phase has open issues
	const passed: StackUnblocked[] = [];
	const rejected: FactoryPhaseRejection[] = [];

	for (const candidate of candidates) {
		const issue = allIssues.find((i) => i.number === candidate.issueNumber);
		if (!issue) { passed.push(candidate); continue; }

		const fp = getIssueFactoryPhase(issue.labels);
		if (!fp) { passed.push(candidate); continue; }
		if (fp.phaseIndex < 0) { passed.push(candidate); continue; } // custom phases pass through

		const appPhases = phaseMap.get(fp.app);
		if (!appPhases) { passed.push(candidate); continue; }
		// Check all earlier standard phases for open issues
		let blocked = false;
		for (let i = 0; i < fp.phaseIndex; i++) {
			const earlier = appPhases.get(i);
			if (earlier && earlier.size > 0) {
				const blockedByPhase = STANDARD_PHASE_ORDER[i] ?? `phase-${i}`;
				rejected.push({
					issue: candidate.issueNumber,
					app: fp.app,
					phase: fp.phase,
					blockedByPhase,
					blockerIssues: [...earlier],
				});
				blocked = true;
				break;
			}
		}
		if (!blocked) passed.push(candidate);
	}

	return { passed, rejected };
}