# Overmind

The Overmind is the persistent agentic loop for the software factory — the judgment layer that gives meaning to mechanical state.

## Location

The Overmind lives in the memex workspace, not in Miranda:

```
memex/heimdall-overmind/
├── Cargo.toml
└── src/
    ├── main.rs         # daemon loop: poll → diff → gate → reason → writeback
    ├── diff.rs         # state diff: extract significant events from snapshots
    ├── gate.rs         # significance gate: debounce, urgency bypass
    ├── reasoning.rs    # multi-turn agentic loop via attractor (Opus 4.6)
    ├── writeback.rs    # POST judgments to Miranda
    ├── tools.rs        # 10 tools: GitHub reads, LanceDB search, effect emitters
    ├── memory.rs       # 5 LanceDB tables with arrow schemas
    └── types.rs        # SignificantEvent, Judgment, Evaluation, AttentionItem
```

## Miranda integration points

| Endpoint | Direction | Purpose |
|---|---|---|
| `GET /api/portfolio/snapshot` | Overmind ← Miranda | Poll current state (localhost-only) |
| `POST /api/portfolio/overmind` | Overmind → Miranda | Write back judgments (localhost-only) |
| `POST /api/sessions/spawn` | Overmind → Miranda | Spawn agent sessions |

## Running

```sh
cd memex
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... cargo run -p heimdall-overmind -- run --repo owner/name
```

## Spec

See `PORTFOLIO_STATE_SPEC.md` §12.3 for the full Overmind specification.
