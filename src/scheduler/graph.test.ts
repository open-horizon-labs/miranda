import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDependencyGraph,
	findUnblockedIssues,
	findStackUnblockedIssues,
} from "./graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(issues: Array<{ number: number; dependsOn: number[] }>) {
	return buildDependencyGraph(
		issues.map((i) => ({ number: i.number, title: `Issue #${i.number}`, dependsOn: i.dependsOn })),
	);
}

// ---------------------------------------------------------------------------
// findUnblockedIssues (existing behavior, regression tests)
// ---------------------------------------------------------------------------

describe("findUnblockedIssues", () => {
	it("returns issues whose deps are all resolved", () => {
		const graph = makeGraph([
			{ number: 11, dependsOn: [10] },
		]);
		const open = new Set([11]);
		const resolved = new Set([10]);

		const result = findUnblockedIssues(graph, open, resolved);
		assert.deepStrictEqual(result, [11]);
	});

	it("returns nothing when deps are still open and unresolved", () => {
		const graph = makeGraph([
			{ number: 11, dependsOn: [10] },
			{ number: 10, dependsOn: [] },
		]);
		const open = new Set([10, 11]);
		const resolved = new Set<number>();

		const result = findUnblockedIssues(graph, open, resolved);
		assert.deepStrictEqual(result, []);
	});

	it("skips issues with no dependencies", () => {
		const graph = makeGraph([
			{ number: 10, dependsOn: [] },
		]);
		const open = new Set([10]);
		const resolved = new Set<number>();

		const result = findUnblockedIssues(graph, open, resolved);
		assert.deepStrictEqual(result, []);
	});
});

// ---------------------------------------------------------------------------
// findStackUnblockedIssues
// ---------------------------------------------------------------------------

describe("findStackUnblockedIssues", () => {
	it("returns issue when its single dep is stack-ready", () => {
		// #11 depends on #10. #10 is open and stack-ready.
		const graph = makeGraph([
			{ number: 10, dependsOn: [] },
			{ number: 11, dependsOn: [10] },
		]);
		const open = new Set([10, 11]);
		const resolved = new Set<number>();
		const stackReady = new Set([10]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, [{ issueNumber: 11, baseDep: 10 }]);
	});

	it("returns nothing when dep is open but not stack-ready", () => {
		const graph = makeGraph([
			{ number: 10, dependsOn: [] },
			{ number: 11, dependsOn: [10] },
		]);
		const open = new Set([10, 11]);
		const resolved = new Set<number>();
		const stackReady = new Set<number>(); // #10 NOT stack-ready

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, []);
	});

	it("returns nothing when dep is resolved (prefer non-stacked path)", () => {
		// #10 is resolved (closed). findUnblockedIssues handles this.
		// findStackUnblockedIssues should NOT return it (no stack-ready dep, all resolved).
		const graph = makeGraph([
			{ number: 11, dependsOn: [10] },
		]);
		const open = new Set([11]);
		const resolved = new Set([10]);
		const stackReady = new Set<number>();

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, []);
	});

	it("handles mixed: one dep resolved, one stack-ready", () => {
		// #12 depends on #10 (resolved) and #11 (stack-ready).
		// Exactly one unmerged dep → eligible for stacking.
		const graph = makeGraph([
			{ number: 11, dependsOn: [] },
			{ number: 12, dependsOn: [10, 11] },
		]);
		const open = new Set([11, 12]);
		const resolved = new Set([10]);
		const stackReady = new Set([11]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, [{ issueNumber: 12, baseDep: 11 }]);
	});

	it("blocks when two deps are both stack-ready (diamond problem)", () => {
		// #13 depends on #11 and #12, both stack-ready.
		// Can't stack on two branches → blocked.
		const graph = makeGraph([
			{ number: 11, dependsOn: [] },
			{ number: 12, dependsOn: [] },
			{ number: 13, dependsOn: [11, 12] },
		]);
		const open = new Set([11, 12, 13]);
		const resolved = new Set<number>();
		const stackReady = new Set([11, 12]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, []);
	});

	it("handles a linear chain: only the immediate child is eligible", () => {
		// Chain: #10 → #11 → #12. Only #10 is stack-ready.
		// #11 can stack on #10. #12 cannot because #11 is NOT stack-ready.
		const graph = makeGraph([
			{ number: 10, dependsOn: [] },
			{ number: 11, dependsOn: [10] },
			{ number: 12, dependsOn: [11] },
		]);
		const open = new Set([10, 11, 12]);
		const resolved = new Set<number>();
		const stackReady = new Set([10]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, [{ issueNumber: 11, baseDep: 10 }]);
	});

	it("skips closed issues", () => {
		const graph = makeGraph([
			{ number: 11, dependsOn: [10] },
		]);
		// #11 is NOT open — already closed
		const open = new Set<number>();
		const resolved = new Set<number>();
		const stackReady = new Set([10]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, []);
	});

	it("skips issues with no dependencies", () => {
		const graph = makeGraph([
			{ number: 10, dependsOn: [] },
		]);
		const open = new Set([10]);
		const resolved = new Set<number>();
		const stackReady = new Set<number>();

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, []);
	});

	it("blocks when one dep is stack-ready and another is open but not ready", () => {
		// #13 depends on #11 (stack-ready) and #12 (open, not ready).
		// Not all deps satisfied → blocked.
		const graph = makeGraph([
			{ number: 11, dependsOn: [] },
			{ number: 12, dependsOn: [] },
			{ number: 13, dependsOn: [11, 12] },
		]);
		const open = new Set([11, 12, 13]);
		const resolved = new Set<number>();
		const stackReady = new Set([11]); // only #11 is ready, #12 is not

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, []);
	});
});

// ---------------------------------------------------------------------------
// Regression: phase-labeled issues are NOT spuriously blocked
// ---------------------------------------------------------------------------

describe("no factory phase gating (regression)", () => {
	it("audit issue is stack-unblocked when its dep is stack-ready, regardless of unrelated build issues", () => {
		// #1178 (audit) depends on #1170 (build, stack-ready).
		// #1236 (build, no PR) is an unrelated open build issue.
		// Previously the phase gate would block #1178 because of #1236.
		// Now only the dependency graph matters.
		const graph = makeGraph([
			{ number: 1170, dependsOn: [] },
			{ number: 1178, dependsOn: [1170] },
			{ number: 1179, dependsOn: [1178] },
			{ number: 1236, dependsOn: [] },
		]);
		const open = new Set([1170, 1178, 1179, 1236]);
		const resolved = new Set<number>();
		const stackReady = new Set([1170]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		// #1178 should be eligible to stack on #1170, unblocked by #1236
		assert.deepStrictEqual(result, [{ issueNumber: 1178, baseDep: 1170 }]);
	});

	it("critique issue is stack-unblocked when its dep is stack-ready, regardless of other open audit issues", () => {
		// #1179 (critique) depends on #1178 (audit, stack-ready).
		// #1180 (audit, open, not ready) is an unrelated audit issue.
		// Dependency graph alone governs scheduling.
		const graph = makeGraph([
			{ number: 1178, dependsOn: [] },
			{ number: 1179, dependsOn: [1178] },
			{ number: 1180, dependsOn: [] },
		]);
		const open = new Set([1178, 1179, 1180]);
		const resolved = new Set<number>();
		const stackReady = new Set([1178]);

		const result = findStackUnblockedIssues(graph, open, resolved, stackReady);
		assert.deepStrictEqual(result, [{ issueNumber: 1179, baseDep: 1178 }]);
	});
});