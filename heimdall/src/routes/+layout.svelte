<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<svelte:head>
	<title>Heimdall</title>
	<meta name="description" content="Ambient awareness surface" />
</svelte:head>

{@render children()}
