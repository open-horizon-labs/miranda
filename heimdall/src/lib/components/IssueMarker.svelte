<script lang="ts">
	import type { AgentInfo, IssueInfo, PREnrichment, MarkerState } from '$lib/types.js';

	interface Props {
		issue: IssueInfo;
		agent: AgentInfo | undefined;
		enrichment: PREnrichment | undefined;
		detail: 'peripheral' | 'ambient' | 'focused';
	}

	let { issue, agent, enrichment, detail }: Props = $props();

	let markerState: MarkerState = $derived.by(() => {
		if (issue.pr?.state === 'merged' || issue.state === 'closed') return 'check-fading';
		if (agent?.status === 'error') return 'filled-accent';
		if (agent?.status === 'asking') return 'filled-frozen';
		if (agent?.status === 'working' || agent?.status === 'thinking' || agent?.status === 'starting') return 'filled-pulsing';
		if (agent?.status === 'blocked') return 'filled-pulsing';
		if (agent?.status === 'done') return 'check-fading';
		if (issue.pr && !agent) return 'rotating';
		if (issue.blockedBy.length > 0 && !agent) return 'hollow-dim';
		return 'hollow-warm';
	});

	let markerColor = $derived(({
		'hollow-dim': 'var(--ground-3)',
		'hollow-warm': 'var(--pulse-active)',
		'filled-pulsing': 'var(--pulse-active)',
		'filled-frozen': 'var(--pulse-active)',
		'filled-accent': 'var(--attention)',
		'rotating': 'var(--review)',
		'check-fading': 'var(--done)',
	} satisfies Record<MarkerState, string>)[markerState]);

	let heartbeatClass = $derived.by(() => {
		if (!agent) return '';
		const map: Record<string, string> = {
			working: 'heartbeat-working',
			thinking: 'heartbeat-thinking',
			starting: 'heartbeat-starting',
			asking: 'heartbeat-asking',
			error: 'heartbeat-error',
			blocked: 'heartbeat-blocked',
			done: 'heartbeat-done',
		};
		return map[agent.status] ?? '';
	});

	let isHollow = $derived(markerState === 'hollow-dim' || markerState === 'hollow-warm');
	let isCheck = $derived(markerState === 'check-fading');
	let isRotating = $derived(markerState === 'rotating');

	let truncatedTitle = $derived(
		issue.title.length > 30 ? issue.title.slice(0, 29) + '\u2026' : issue.title
	);

	let agentStatusText = $derived.by(() => {
		if (!agent) return '';
		switch (agent.status) {
			case 'working': return `working ${agent.elapsed}`;
			case 'thinking': return `thinking ${agent.elapsed}`;
			case 'starting': return 'starting';
			case 'asking': return 'asking';
			case 'error': return 'error';
			case 'blocked': return 'blocked';
			case 'done': return 'done';
			default: return agent.status;
		}
	});

	let ciState = $derived.by(() => {
		if (!enrichment) return null;
		const s = enrichment.ci.state;
		if (s === 'success') return 'pass';
		if (s === 'failure' || s === 'error') return 'fail';
		return 'pending';
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span class="issue-marker" class:peripheral={detail === 'peripheral'} class:ambient={detail === 'ambient'} class:focused={detail === 'focused'} role="listitem" tabindex={detail === 'peripheral' ? undefined : 0}>
	<svg
		class="marker-svg {heartbeatClass}"
		class:rotate-slow={isRotating}
		width="12"
		height="12"
		viewBox="0 0 12 12"
		aria-hidden="true"
	>
		{#if isCheck}
			<polyline
				points="2.5,6.5 5,9 9.5,3"
				fill="none"
				stroke={markerColor}
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		{:else if isHollow}
			<circle cx="6" cy="6" r="4.5" fill="none" stroke={markerColor} stroke-width="1.5" />
		{:else}
			<circle cx="6" cy="6" r="5" fill={markerColor} />
		{/if}
	</svg>

	{#if detail !== 'peripheral'}
		<span class="issue-number tabular-nums">#{issue.number}</span>
		<span class="issue-title">{detail === 'ambient' ? truncatedTitle : issue.title}</span>
	{/if}

	{#if detail === 'focused'}
		{#if agent}
			<span class="agent-status small-caps">{agentStatusText}</span>
		{/if}
		{#if issue.pr}
			<a class="pr-link" href={issue.pr.url} target="_blank" rel="noopener">
				<span class="pr-state-indicator" data-state={issue.pr.state}></span>
				PR #{issue.pr.number}
			</a>
		{/if}
		{#if ciState}
			<span class="ci-badge" data-ci={ciState}></span>
		{/if}
	{/if}
</span>

<style>
	.issue-marker {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		line-height: 1;
		min-width: 0;
	}

	.marker-svg {
		flex-shrink: 0;
	}

	.issue-number {
		font-size: var(--text-xs);
		font-family: var(--font-data);
		color: var(--ground-4);
		flex-shrink: 0;
	}

	.issue-title {
		font-size: var(--text-sm);
		font-family: var(--font-data);
		color: var(--ground-5);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.agent-status {
		font-size: var(--text-xs);
		font-family: var(--font-data);
		color: var(--ground-4);
		flex-shrink: 0;
	}

	.pr-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-xs);
		font-family: var(--font-data);
		color: var(--ground-4);
		text-decoration: none;
		flex-shrink: 0;
	}

	.pr-link:hover {
		color: var(--ground-5);
	}

	.pr-state-indicator {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ground-3);
	}

	.pr-state-indicator[data-state="open"] {
		background: var(--pulse-active);
	}

	.pr-state-indicator[data-state="merged"] {
		background: var(--done);
	}

	.pr-state-indicator[data-state="closed"] {
		background: var(--ground-3);
	}

	.ci-badge {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.ci-badge[data-ci="pass"] {
		background: var(--done);
	}

	.ci-badge[data-ci="fail"] {
		background: var(--attention);
	}

	.ci-badge[data-ci="pending"] {
		background: var(--waiting);
	}

	@keyframes rotate-slow {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.rotate-slow {
		animation: rotate-slow 4s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.rotate-slow {
			animation: none;
		}
	}
</style>
