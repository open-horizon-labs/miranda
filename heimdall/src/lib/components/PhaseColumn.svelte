<script lang="ts">
	import type { Phase, IssueInfo, AgentInfo, PREnrichment } from '$lib/types.js';
	import type { TransitionConfig } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { expoOut } from 'svelte/easing';
	import IssueMarker from '$lib/components/IssueMarker.svelte';

	type CrossfadeTransition = (node: Element, params: { key: unknown }, intro: { direction: 'in' | 'out' | 'both' }) => () => TransitionConfig;

	interface Props {
		phase: Phase;
		issues: IssueInfo[];
		agents: Map<number, AgentInfo>;
		enrichment: Record<number, PREnrichment>;
		send: CrossfadeTransition;
		receive: CrossfadeTransition;
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

	const prefersReducedMotion =
		typeof window !== 'undefined'
			? window.matchMedia('(prefers-reduced-motion: reduce)')
			: null;

	const FLIP_DURATION = (_d: number) => (prefersReducedMotion?.matches ? 0 : 800);

	let { phase, issues, agents, enrichment, send, receive }: Props = $props();

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
			<div
				class="issue-slot"
				in:receive={{ key: issue.number }}
				out:send={{ key: issue.number }}
				animate:flip={{ duration: FLIP_DURATION, easing: expoOut }}
			>
				<IssueMarker
					{issue}
					agent={agents.get(issue.number)}
					enrichment={issue.pr ? enrichment[issue.pr.number] : undefined}
					detail="ambient"
				/>
			</div>
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
		opacity: 0.45;
		filter: saturate(0.3);
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
