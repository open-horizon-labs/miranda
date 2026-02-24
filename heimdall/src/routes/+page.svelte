<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { portfolio } from '$lib/stores/portfolio.js';
	import PortfolioBar from '$lib/components/PortfolioBar.svelte';
	import AppRegion from '$lib/components/AppRegion.svelte';
	import AttentionStrip from '$lib/components/AttentionStrip.svelte';

	onMount(() => {
		portfolio.start();
	});

	onDestroy(() => {
		portfolio.stop();
	});
</script>

<div class="surface">
	<header class="portfolio-bar">
		<PortfolioBar
			activeAgents={portfolio.activeAgents}
			totalCapacity={portfolio.totalCapacity}
			loading={portfolio.loading}
		/>
	</header>

	<main class="app-regions">
		{#each portfolio.apps as app (app.name)}
			<AppRegion {app} />
		{/each}
		{#if portfolio.error}
			<div class="error-banner">{portfolio.error}</div>
		{/if}
		{#if portfolio.apps.length === 0 && !portfolio.loading && !portfolio.error}
			<div class="empty-state">
				<span class="font-display">No projects</span>
			</div>
		{/if}
	</main>

	<footer class="attention-strip-container">
		<AttentionStrip items={portfolio.attention} />
	</footer>
</div>

<style>
	.surface {
		display: grid;
		grid-template-rows: auto 1fr auto;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		background: var(--ground-0);
	}

	.portfolio-bar {
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid var(--ground-2);
	}

	.app-regions {
		overflow-y: auto;
		padding: 1rem 1.5rem;
		container-type: inline-size;
	}

	.attention-strip-container {
		position: sticky;
		bottom: 0;
		border-top: 1px solid var(--ground-2);
		background: var(--ground-1);
	}

	.error-banner {
		padding: 0.5rem 1rem;
		background: color-mix(in oklch, var(--attention) 10%, var(--ground-1));
		color: var(--attention);
		font-size: var(--text-sm);
		border-radius: 4px;
		margin-bottom: 0.5rem;
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--ground-3);
		font-size: var(--text-lg);
	}
</style>
