<script lang="ts">
	import type { Phase, IssueInfo, AgentInfo, PREnrichment } from '$lib/types.js';
	import IssueMarker from '$lib/components/IssueMarker.svelte';

	interface Props {
		phase: Phase;
		issues: IssueInfo[];
		agents: Map<number, AgentInfo>;
		enrichment: Record<number, PREnrichment>;
	}

	const PHASE_LABELS: Record<Phase, string> = {
		queued: 'Queued',
		building: 'Build',
		review: 'Review',
		done: 'Done',
	};

	const BASE_GROW: Record<Phase, number> = {
		queued: 1,
		building: 2,
		review: 1.5,
		done: 0.5,
	};

	let { phase, issues, agents, enrichment }: Props = $props();

	// Done column grows proportionally to completed volume:
	// base 0.5 + 0.15 per item, capped at 2.5 so it doesn't dominate.
	let grow = $derived(
		phase === 'done'
			? Math.min(0.5 + issues.length * 0.15, 2.5)
			: BASE_GROW[phase]
	);

	let doneCount = $derived(phase === 'done' ? issues.length : 0);
</script>

<section
	class="phase-column phase-{phase}"
	style:flex-grow={grow}
	aria-label={PHASE_LABELS[phase]}
>
	<header class="phase-label small-caps">
		{PHASE_LABELS[phase]}
		{#if doneCount > 0}
			<span class="done-count tabular-nums">{doneCount}</span>
		{/if}
	</header>
	<div class="issue-list" role="list">
		{#each issues as issue (issue.number)}
			<IssueMarker
				{issue}
				agent={agents.get(issue.number)}
				enrichment={issue.pr ? enrichment[issue.pr.number] : undefined}
				detail="ambient"
			/>
		{/each}
	</div>
</section>

<style>
	.phase-column {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 0.25rem;
		container-type: inline-size;
	}

	.phase-label {
		font-family: var(--font-display);
		font-size: var(--text-xs);
		color: var(--ground-3);
		padding-block-end: 0.25rem;
		user-select: none;
	}

	.issue-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}

	.phase-building {
		background: var(--ground-1);
	}

	.phase-review {
		background: color-mix(in oklch, var(--review) 5%, transparent);
	}

	.phase-done {
		background: color-mix(in oklch, var(--done) 4%, transparent);
		border-radius: 4px;
	}

	.done-count {
		font-family: var(--font-data);
		font-size: var(--text-xs);
		color: var(--done);
		margin-inline-start: 0.25rem;
	}
</style>
