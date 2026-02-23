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