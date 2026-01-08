# Miranda

Telegram bot for remote Claude orchestration. The ractor who gives voice to the Primer.

## Naming (Diamond Age by Neal Stephenson)

| Component | Name | Reference |
|-----------|------|-----------|
| This bot | **Miranda** | The ractor who voices the Primer for Nell |
| Task runner | **Mouse** | Small autonomous worker from the Mouse Army |
| Batch merge | **Drummer** | The collective that processes in rhythm |
| PR feedback | **Notes** | Director's notes to ractors |

## What Miranda Does

1. **Remote orchestration** - Start tasks, respond to questions, merge PRs from your phone
2. **Project discovery** - List projects and tasks on the server
3. **Session management** - Spawn, monitor, and control Claude tmux sessions
4. **Notifications** - Push alerts when Claude needs input (via Telegram)
5. **Bootstrap** - Set up Claude Code on new machines (skills, hooks, plugins)

## Architecture

```
Phone ↔ Telegram ↔ Miranda ↔ tmux sessions (Claude /mouse)
                      ↑
                PreToolUse hook (notify-miranda.sh)
```

## Development

```bash
# Install dependencies
pnpm install

# Development (hot reload)
pnpm dev

# Build
pnpm build

# Production
pnpm start
```

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=xxx      # From @BotFather
ALLOWED_USER_IDS=123,456    # Telegram user IDs (comma-separated)

# Optional
MIRANDA_PORT=3847           # HTTP port for hook notifications (default: 3847)
SQLITE_PATH=./miranda.db    # SQLite database path
PROJECTS_DIR=~/projects     # Directory to scan for ba projects (default: ~/projects)
```

## Project Structure

```
src/
├── index.ts           # Entry point, bot setup
├── bot/
│   ├── commands.ts    # /mouse, /status, /drummer, etc.
│   └── callbacks.ts   # Inline keyboard handlers
├── tmux/
│   └── sessions.ts    # tmux session management
├── hooks/
│   └── server.ts      # HTTP server for hook notifications
├── state/
│   └── db.ts          # SQLite state management
└── types.ts           # Shared types
```

## Commands

| Command | Action |
|---------|--------|
| `/projects` | List projects on server with task counts |
| `/update` | Pull all clean projects (skips dirty/active) |
| `/tasks <project>` | List tasks for a project |
| `/newproject <repo>` | Clone GitHub repo and init ba/sg |
| `/mouse <task>` | Start mouse skill for task |
| `/drummer` | Run batch merge skill |
| `/notes <pr-number>` | Address human PR feedback |
| `/status` | Show all active sessions |
| `/logs <task>` | Show recent output |
| `/stop <task>` | Kill a session |
| `/cleanup` | Remove orphaned tmux sessions |
| `/ssh` | Get SSH command for manual access |

### `/newproject` Details

Clones a GitHub repository and initializes development tools in one step.

**Usage:**
```
/newproject owner/repo
/newproject https://github.com/owner/repo
/newproject git@github.com:owner/repo.git
```

**What happens:**
1. Clones to `$PROJECTS_DIR/<repo-name>` via `gh repo clone`
2. Runs `ba init` (task tracking)
3. Runs `sg init` (superego)

**Notes:**
- GitHub only (uses `gh` CLI)
- Reports partial success if clone works but init fails
- 10-minute clone timeout, 30-second per-tool init timeout

## Hook Integration

Claude Code on the server has a PreToolUse hook that POSTs to Miranda when `AskUserQuestion` is called:

```bash
# ~/.claude/hooks/notify-miranda.sh
#!/bin/bash
curl -X POST http://localhost:3847/notify \
  -H "Content-Type: application/json" \
  -d "{
    \"session\": \"$TMUX_SESSION\",
    \"tool\": \"$CLAUDE_TOOL_NAME\",
    \"input\": $CLAUDE_TOOL_INPUT
  }"
```

## Bootstrap Script

`scripts/bootstrap.sh` sets up Claude Code on a new machine after auth:

```bash
./scripts/bootstrap.sh [--skills-source <path>]
```

**What it installs:**

| Component | Source | Purpose |
|-----------|--------|---------|
| **Skills** | Copy from local or git repo | mouse, drummer, dive-prep, playbook |
| **Hooks** | Miranda repo | notify-miranda.sh for notifications |
| **ba** | cargo install | Task tracking |
| **sg** | cargo install | Superego metacognitive advisor |
| **wm** | cargo install | Working memory |
| **MCP servers** | claude mcp add | oh-mcp, context7, etc. |
| **Plugins** | claude plugin install | superego plugin |

**Usage:**

```bash
# On new machine, after `claude` is authenticated:

# Option 1: Copy skills from local machine
scp -r ~/.claude/skills/ hetzner:~/skills-to-copy/
ssh hetzner
./bootstrap.sh --skills-source ~/skills-to-copy

# Option 2: Bootstrap will prompt for skills location
./bootstrap.sh
```

**Environment after bootstrap:**

```
~/.claude/
├── skills/
│   ├── mouse/SKILL.md
│   ├── drummer/SKILL.md
│   └── ...
├── hooks/
│   └── notify-miranda.sh
└── settings.json (with hooks configured)

# Also installed:
ba --version    # Task tracking
sg --version    # Superego
wm --version    # Working memory
```

## Implementation Phases

### Phase 1: MVP (Dogfood)
- [ ] tmux session spawning (`/mouse`)
- [ ] HTTP endpoint for hook notifications
- [ ] Inline keyboard for question responses
- [ ] Callback → tmux send-keys
- [ ] `/status` command

### Phase 2: Discovery
- [ ] `/projects` - list projects on server
- [ ] `/tasks <project>` - list tasks with inline selection
- [ ] `/drummer` command

### Phase 3: Bootstrap
- [ ] `bootstrap.sh` script
- [ ] Skills copying
- [ ] ba/sg/wm installation
- [ ] Hook setup
- [ ] MCP server configuration

### Phase 4: Polish
- [ ] `/logs` streaming
- [ ] SQLite state persistence
- [ ] Message editing (update in place)
- [ ] Error recovery
- [ ] Session crash detection
