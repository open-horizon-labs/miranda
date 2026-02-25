<script lang="ts">
	import type { AppRegionData, Phase, AgentInfo } from '$lib/types.js';
	import { crossfade } from 'svelte/transition';
	import { expoOut } from 'svelte/easing';
	import PhaseColumn from '$lib/components/PhaseColumn.svelte';

	interface Props {
		app: AppRegionData;
	}

	const PHASES: Phase[] = ['queued', 'building', 'review', 'done'];

	const prefersReducedMotion =
		typeof window !== 'undefined'
			? window.matchMedia('(prefers-reduced-motion: reduce)')
			: null;

	const [send, receive] = crossfade({
		duration: () => (prefersReducedMotion?.matches ? 0 : 800),
		easing: expoOut,
		fallback(node) {
			const d = prefersReducedMotion?.matches ? 0 : 300;
			return { duration: d, css: (t: number) => `opacity: ${t}` };
		},
	});

	let { app }: Props = $props();

	let agents = $derived(Array.from(app.agents.values()));

	let activeCount = $derived(
		agents.filter((a) => a.status === 'working' || a.status === 'thinking' || a.status === 'starting').length
	);

	let askingCount = $derived(
		agents.filter((a) => a.status === 'asking').length
	);

	let temperature = $derived.by(() => {
		if (askingCount > 0) return 'var(--temperature-asking)';
		if (activeCount >= 3) return 'var(--temperature-hot)';
		if (activeCount >= 1) return 'var(--temperature-warm)';
		return 'transparent';
	});
</script>

<div class="app-region" style:--region-temp={temperature}>
	<div class="app-name">
		{app.name}
	</div>
	<div class="phase-flow">
		{#each PHASES as phase (phase)}
			<PhaseColumn
				{phase}
				issues={app.phases[phase]}
				agents={app.agents}
				enrichment={app.enrichment}
				{send}
				{receive}
			/>
		{/each}
	</div>
</div>

<style>
	.app-region {
		display: grid;
		grid-template-columns: minmax(8rem, auto) 1fr;
		gap: 1rem;
		padding: 1rem 0;
		border-bottom: 1px solid var(--ground-2);
		container-type: inline-size;
		background: var(--region-temp, transparent);
		transition: background var(--duration-temperature, 1s) var(--ease-out-quart);
	}

	.app-name {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		color: var(--ground-5);
		display: flex;
		align-items: center;
	}

	.phase-flow {
		display: flex;
		gap: 0.5rem;
	}

	@container (max-width: 768px) {
		.app-region {
			grid-template-columns: 1fr;
		}
		.phase-flow {
			flex-direction: column;
		}
	}
</style>
