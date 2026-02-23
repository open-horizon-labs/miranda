import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDependencyGraph,
	findUnblockedIssues,
	findStackUnblockedIssues,
	parseFactoryLabel,
	getIssueFactoryPhase,
	filterByFactoryPhase,
	type StackUnblocked,
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
// parseFactoryLabel
// ---------------------------------------------------------------------------

describe("parseFactoryLabel", () => {
	it("parses valid factory label", () => {
		const result = parseFactoryLabel("factory:dm:audit");
		assert.deepStrictEqual(result, { app: "dm", phase: "audit", phaseIndex: 1 });
	});

	it("returns null for non-factory label", () => {
		assert.strictEqual(parseFactoryLabel("oh-planned"), null);
		assert.strictEqual(parseFactoryLabel("bug"), null);
	});

	it("returns null for unknown phase", () => {
		assert.strictEqual(parseFactoryLabel("factory:dm:deploy"), null);
	});

	it("returns null for malformed label", () => {
		assert.strictEqual(parseFactoryLabel("factory:dm"), null);
		assert.strictEqual(parseFactoryLabel("factory"), null);
		assert.strictEqual(parseFactoryLabel("factory:dm:audit:extra"), null);
	});

	it("parses all valid phases with correct order", () => {
		assert.strictEqual(parseFactoryLabel("factory:dm:build")!.phaseIndex, 0);
		assert.strictEqual(parseFactoryLabel("factory:dm:audit")!.phaseIndex, 1);
		assert.strictEqual(parseFactoryLabel("factory:dm:critique")!.phaseIndex, 2);
	});
});

// ---------------------------------------------------------------------------
// getIssueFactoryPhase
// ---------------------------------------------------------------------------

describe("getIssueFactoryPhase", () => {
	it("finds factory label among other labels", () => {
		const result = getIssueFactoryPhase(["oh-planned", "factory:dm:audit", "bug"]);
		assert.deepStrictEqual(result, { app: "dm", phase: "audit", phaseIndex: 1 });
	});

	it("returns null when no factory label present", () => {
		assert.strictEqual(getIssueFactoryPhase(["oh-planned", "bug"]), null);
		assert.strictEqual(getIssueFactoryPhase([]), null);
	});
});

// ---------------------------------------------------------------------------
// filterByFactoryPhase
// ---------------------------------------------------------------------------

describe("filterByFactoryPhase", () => {
	it("blocks critique when audit-phase issues are still open", () => {
		// Audit (#20) and fix-A (#21) are audit-phase. Critique (#22) is critique-phase.
		// fix-A is still open → critique is blocked.
		const candidates: StackUnblocked[] = [
			{ issueNumber: 21, baseDep: 20 },  // fix-A can stack
			{ issueNumber: 22, baseDep: 20 },  // critique should be blocked
		];
		const allIssues = [
			{ number: 20, labels: ["factory:dm:audit"] },
			{ number: 21, labels: ["factory:dm:audit"] },  // fix-A
			{ number: 22, labels: ["factory:dm:critique"] },  // critique
		];
		const open = new Set([20, 21, 22]);

		const result = filterByFactoryPhase(candidates, allIssues, open);
		assert.deepStrictEqual(result, [{ issueNumber: 21, baseDep: 20 }]);
	});

	it("unblocks critique when all audit-phase issues are closed", () => {
		// All audit-phase issues closed (not in open set). Critique can proceed.
		const candidates: StackUnblocked[] = [
			{ issueNumber: 22, baseDep: 20 },
		];
		const allIssues = [
			{ number: 20, labels: ["factory:dm:audit"] },
			{ number: 21, labels: ["factory:dm:audit"] },
			{ number: 22, labels: ["factory:dm:critique"] },
		];
		const open = new Set([22]); // only critique is open

		const result = filterByFactoryPhase(candidates, allIssues, open);
		assert.deepStrictEqual(result, [{ issueNumber: 22, baseDep: 20 }]);
	});

	it("passes through non-factory issues unchanged", () => {
		const candidates: StackUnblocked[] = [
			{ issueNumber: 50, baseDep: 49 },
		];
		const allIssues = [
			{ number: 49, labels: ["oh-planned"] },
			{ number: 50, labels: ["oh-planned"] },
		];
		const open = new Set([49, 50]);

		const result = filterByFactoryPhase(candidates, allIssues, open);
		assert.deepStrictEqual(result, [{ issueNumber: 50, baseDep: 49 }]);
	});

	it("handles mixed factory and non-factory issues", () => {
		const candidates: StackUnblocked[] = [
			{ issueNumber: 21, baseDep: 20 },  // factory audit
			{ issueNumber: 22, baseDep: 20 },  // factory critique (blocked)
			{ issueNumber: 50, baseDep: 49 },  // non-factory (passes through)
		];
		const allIssues = [
			{ number: 20, labels: ["factory:dm:audit"] },
			{ number: 21, labels: ["factory:dm:audit"] },
			{ number: 22, labels: ["factory:dm:critique"] },
			{ number: 49, labels: ["oh-planned"] },
			{ number: 50, labels: ["oh-planned"] },
		];
		const open = new Set([20, 21, 22, 49, 50]);

		const result = filterByFactoryPhase(candidates, allIssues, open);
		const issues = result.map((r) => r.issueNumber);
		assert.ok(issues.includes(21), "audit fix passes");
		assert.ok(!issues.includes(22), "critique blocked");
		assert.ok(issues.includes(50), "non-factory passes");
	});

	it("blocks audit when build-phase issues are still open", () => {
		const candidates: StackUnblocked[] = [
			{ issueNumber: 103, baseDep: 102 },  // audit
		];
		const allIssues = [
			{ number: 102, labels: ["factory:dm:build"] },  // ui (still open)
			{ number: 103, labels: ["factory:dm:audit"] },
		];
		const open = new Set([102, 103]);

		const result = filterByFactoryPhase(candidates, allIssues, open);
		assert.deepStrictEqual(result, []);
	});

	it("full factory lifecycle: build done, audit in progress, critique waits", () => {
		// Build phase: #100 (module), #101 (app), #102 (ui) — all closed
		// Audit phase: #103 (audit, stack-ready), #104 (fix-A, open), #105 (fix-B, open)
		// Critique phase: #106 (critique, open)
		const candidates: StackUnblocked[] = [
			{ issueNumber: 104, baseDep: 103 },  // fix-A can stack on audit
			{ issueNumber: 106, baseDep: 103 },  // critique should be blocked
		];
		const allIssues = [
			{ number: 100, labels: ["factory:dm:build"] },
			{ number: 101, labels: ["factory:dm:build"] },
			{ number: 102, labels: ["factory:dm:build"] },
			{ number: 103, labels: ["factory:dm:audit"] },
			{ number: 104, labels: ["factory:dm:audit"] },
			{ number: 105, labels: ["factory:dm:audit"] },
			{ number: 106, labels: ["factory:dm:critique"] },
		];
		const open = new Set([103, 104, 105, 106]); // build issues closed

		const result = filterByFactoryPhase(candidates, allIssues, open);
		assert.deepStrictEqual(result, [{ issueNumber: 104, baseDep: 103 }]);
	});

	it("independent factory apps don't block each other", () => {
		// dm audit still open, but cook critique should not be blocked by dm audit
		const candidates: StackUnblocked[] = [
			{ issueNumber: 200, baseDep: 199 },  // cook critique
		];
		const allIssues = [
			{ number: 103, labels: ["factory:dm:audit"] },  // dm audit still open
			{ number: 199, labels: ["factory:cook:audit"] },  // cook audit
			{ number: 200, labels: ["factory:cook:critique"] },  // cook critique
		];
		const open = new Set([103, 200]); // dm audit open, cook audit closed

		const result = filterByFactoryPhase(candidates, allIssues, open);
		assert.deepStrictEqual(result, [{ issueNumber: 200, baseDep: 199 }]);
	});
});