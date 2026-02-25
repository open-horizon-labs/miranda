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

	const PHASE_GROW: Record<Phase, number> = {
		queued: 1,
		building: 2,
		review: 1.5,
		done: 0.5,
	};

	let { phase, issues, agents, enrichment }: Props = $props();

	let grow = $derived(PHASE_GROW[phase]);
</script>

<section
	class="phase-column phase-{phase}"
	style:flex-grow={grow}
	aria-label={PHASE_LABELS[phase]}
>
	<header class="phase-label small-caps">{PHASE_LABELS[phase]}</header>
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
		opacity: 0.7;
	}
</style>
