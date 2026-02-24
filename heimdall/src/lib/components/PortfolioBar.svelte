<script lang="ts">
	interface Props {
		activeAgents: number;
		totalCapacity: number;
		loading: boolean;
	}

	let { activeAgents, totalCapacity, loading }: Props = $props();

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
</style>
