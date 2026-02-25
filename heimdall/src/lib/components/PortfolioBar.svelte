<script lang="ts">
	interface Props {
		activeAgents: number;
		totalCapacity: number;
		loading: boolean;
		doneToday: number;
	}

	let { activeAgents, totalCapacity, loading, doneToday }: Props = $props();

	let pulseClass = $derived(
		loading ? 'pulse heartbeat-starting' : activeAgents > 0 ? 'pulse heartbeat-working' : 'pulse idle'
	);
</script>

<div class="portfolio-bar">
	<div class={pulseClass}></div>

	<span class="project-name">Heimdall</span>

	<div class="capacity">
		{#each Array(totalCapacity) as _, i}
			<div class="dot" class:filled={i < activeAgents}></div>
		{/each}
	</div>

	{#if doneToday > 0}
		<span class="done-today tabular-nums">
			<svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
				<polyline
					points="2.5,6.5 5,9 9.5,3"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			{doneToday} today
		</span>
	{/if}
</div>

<style>
	.portfolio-bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.pulse {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--pulse-active);
		flex-shrink: 0;
	}

	.pulse.idle {
		background: var(--ground-3);
	}

	.project-name {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		color: var(--ground-5);
		flex-shrink: 0;
	}

	.capacity {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ground-2);
		transition: background var(--duration-status) var(--ease-out-quart);
	}

	.dot.filled {
		background: var(--pulse-active);
	}

	.done-today {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-data);
		font-size: var(--text-xs);
		color: var(--done);
		margin-inline-start: auto;
		flex-shrink: 0;
	}
</style>
