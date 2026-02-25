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
		{#if portfolio.loading}
			<div class="skeleton" role="status" aria-label="Loading portfolio">
				{#each Array(3) as _}
					<div class="skel-app">
						<div class="skel-block skel-name"></div>
						<div class="skel-phases">
							<div class="skel-block skel-phase"></div>
							<div class="skel-block skel-phase"></div>
							<div class="skel-block skel-phase"></div>
							<div class="skel-block skel-phase"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			{#each portfolio.apps as app (app.name)}
				<AppRegion {app} />
			{/each}
			{#if portfolio.error}
				<div class="error-banner">{portfolio.error}</div>
			{/if}
			{#if portfolio.apps.length === 0 && !portfolio.error}
				<div class="empty-state">
					<span class="font-display">No projects</span>
				</div>
			{/if}
		{/if}
	</main>

	<footer class="attention-strip-container">
		{#if portfolio.loading}
			<div class="skel-attention" aria-hidden="true">
				<div class="skel-block skel-attention-item"></div>
				<div class="skel-block skel-attention-item"></div>
			</div>
		{:else}
			<AttentionStrip items={portfolio.attention} />
		{/if}
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

	/* ═══════════ Loading Skeleton ═══════════ */

	.skel-block {
		position: relative;
		overflow: hidden;
		background: var(--ground-2);
		border-radius: 4px;
	}

	.skel-block::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent 0%,
			color-mix(in oklch, var(--ground-1) 60%, transparent) 50%,
			transparent 100%
		);
		transform: translateX(-100%);
		animation: shimmer 1.5s var(--ease-out-quart) infinite;
	}

	@keyframes shimmer {
		to {
			transform: translateX(100%);
		}
	}

	.skel-app {
		display: grid;
		grid-template-columns: minmax(8rem, auto) 1fr;
		gap: 1rem;
		padding: 1rem 0;
		border-bottom: 1px solid var(--ground-2);
	}

	.skel-name {
		width: 7rem;
		height: 1.25rem;
		align-self: center;
	}

	.skel-phases {
		display: flex;
		gap: 0.5rem;
	}

	.skel-phase {
		flex: 1;
		height: 3.5rem;
	}

	.skel-attention {
		padding: 0.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.skel-attention-item {
		height: 1.25rem;
	}

	.skel-attention-item:first-child {
		width: 55%;
	}

	.skel-attention-item:last-child {
		width: 35%;
	}

	@container (max-width: 768px) {
		.skel-app {
			grid-template-columns: 1fr;
		}

		.skel-phases {
			flex-direction: column;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skel-block::after {
			animation: none;
			display: none;
		}
	}
</style>
