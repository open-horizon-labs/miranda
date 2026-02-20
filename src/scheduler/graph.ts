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