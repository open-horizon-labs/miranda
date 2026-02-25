<script lang="ts">
	import type { AttentionItem } from '$lib/types.js';

	interface Props {
		items: AttentionItem[];
	}

	let { items }: Props = $props();

	const actionLabels: Record<AttentionItem['reason'], string> = {
		asking: 'Answer',
		'ci-failed': 'Fix CI',
		conflicts: 'Resolve',
		'review-needed': 'Review',
	};
</script>

<div class="attention-strip" aria-live="polite" role="log" aria-relevant="additions removals">
	{#if items.length > 0}
		{#each items as item (item.id)}
			<div class="attention-item" aria-label="{item.project} #{item.issueNumber}: {item.title} — {actionLabels[item.reason]}">
				<span class="reason-icon reason-{item.reason}">
					{#if item.reason === 'asking'}
						<svg viewBox="0 0 14 14" class="icon heartbeat-asking" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="currentColor"/></svg>
					{:else if item.reason === 'ci-failed'}
						<svg viewBox="0 0 14 14" class="icon" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" fill="none"/></svg>
					{:else if item.reason === 'conflicts'}
						<svg viewBox="0 0 14 14" class="icon" aria-hidden="true"><path d="M7 1l6 12H1z" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="7" y="11" text-anchor="middle" font-size="8" fill="currentColor">!</text></svg>
					{:else if item.reason === 'review-needed'}
						<svg viewBox="0 0 14 14" class="icon" aria-hidden="true"><ellipse cx="7" cy="7" rx="6" ry="4" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></svg>
					{/if}
				</span>

				<span class="item-ref tabular-nums">{item.project} #{item.issueNumber}</span>

				<span class="item-title">{item.title}</span>

				<span class="item-action">
					{#if item.reason === 'review-needed' && item.prUrl}
						<a class="action-btn" href={item.prUrl} target="_blank" rel="noopener noreferrer">{actionLabels[item.reason]}</a>
					{:else}
						<button class="action-btn" type="button" disabled>{actionLabels[item.reason]}</button>
					{/if}
				</span>
			</div>
		{/each}
	{/if}
</div>

<style>
	.attention-strip {
		padding: 0.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 30vh;
		overflow-y: auto;
	}

	.attention-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.25rem 0;
		font-size: var(--text-sm);
		transition: background var(--duration-attention) var(--ease-out-expo);
		animation: slide-in-right var(--duration-appear) var(--ease-out-quart) both;
	}

	@keyframes slide-in-right {
		from {
			opacity: 0;
			transform: translateX(1.5rem);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	.reason-icon {
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}

	.reason-icon :global(.icon) {
		width: 14px;
		height: 14px;
	}

	.reason-asking {
		color: var(--attention);
	}

	.reason-ci-failed {
		color: var(--attention);
	}

	.reason-conflicts {
		color: var(--attention);
	}

	.reason-review-needed {
		color: var(--review);
	}

	.item-ref {
		flex-shrink: 0;
		font-size: var(--text-xs);
		color: var(--ground-4);
	}

	.item-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ground-5);
	}

	.item-action {
		flex-shrink: 0;
	}

	.action-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: var(--text-xs);
		font-family: inherit;
		background: var(--ground-2);
		color: var(--ground-5);
		border: none;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		min-height: 24px;
		min-width: 24px;
		cursor: pointer;
		text-decoration: none;
		transition: background var(--duration-status) var(--ease-out-expo);
	}

	.action-btn::after {
		content: '';
		position: absolute;
		inset: -12px -8px;
	}

	.action-btn:hover {
		background: var(--ground-3);
	}

	.action-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.attention-item {
			animation: none;
		}
	}
</style>
