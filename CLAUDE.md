# Miranda

Telegram bot for remote Claude orchestration. The ractor who gives voice to the Primer.

## Naming (Diamond Age by Neal Stephenson)

| Component | Name | Reference |
|-----------|------|-----------|
| This bot | **Miranda** | The ractor who voices the Primer for Nell |
| Task planner | **oh-plan** | Investigates and creates GitHub issues |
| Issue worker | **oh-task** | Works GitHub issues autonomously |
| Batch merger | **oh-merge** | Merges issue PRs in rhythm |
| PR feedback | **oh-notes** | Addresses review comments |

## What Miranda Does

1. **Remote orchestration** - Start tasks, respond to questions, merge PRs from your phone
2. **Project discovery** - List projects and GitHub issues on the server
3. **Session management** - Spawn, monitor, and control oh-my-pi agent processes
4. **Notifications** - Push alerts when Claude needs input (via Telegram, using RPC events)
5. **Bootstrap** - Set up Claude Code on new machines (skills, hooks, plugins)

## Architecture

```
Phone <-> Telegram <-> Miranda <-> oh-my-pi agent processes (RPC mode)
                                       |
                                   JSON-RPC over stdin/stdout
```

Miranda spawns oh-my-pi in RPC mode and communicates via JSON lines:
- Agent questions arrive as `extension_ui_request` events on stdout
- User responses are sent as `extension_ui_response` commands on stdin
- Completion is signaled via `agent_end` events or process exit

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
OMP_CLI_PATH=/path/to/oh-my-pi/cli.js  # Path to oh-my-pi CLI

# Optional
SQLITE_PATH=./miranda.db    # SQLite database path
PROJECTS_DIR=~/projects     # Directory to scan for projects (default: ~/projects)
MIRANDA_HOME=~/miranda      # Override Miranda project root (default: derived from module location)
```

## Project Structure

```
src/
├── index.ts           # Entry point, bot setup
├── bot/
│   ├── commands.ts    # /ohtask, /status, /ohmerge, etc.
│   └── keyboards.ts   # Inline keyboard builders and parsers
├── agent/
│   ├── process.ts     # oh-my-pi RPC process management
│   └── events.ts      # RPC event handlers
├── state/
│   └── sessions.ts    # Session state management
└── types.ts           # Shared types
```

## Commands

### GitHub Issue Workflow (Recommended)

| Command | Action |
|---------|--------|
| `/ohplan <project> <description>` | Plan task and create GitHub issues |
| `/ohtask <project> <issue>... [--base branch]` | Start oh-task skill for GitHub issue(s) |
| `/ohmerge <project>` | Batch merge GitHub issue PRs (oh-merge label) |
| `/ohnotes <project> <pr>` | Address GitHub issue PR feedback |

### Project Management

| Command | Action |
|---------|--------|
| `/projects` | List projects on server with task counts |
| `/tasks <project>` | List tasks for a project |
| `/newproject <repo>` | Clone GitHub repo and init sg |
| `/pull` | Pull all clean projects (skips dirty/active) |
| `/reset <project>` | Hard reset project to origin (with confirmation) |

### Session Management

| Command | Action |
|---------|--------|
| `/status` | Show all active sessions |
| `/logs <task>` | Show recent output |
| `/stop <task>` | Kill a session |
| `/cleanup` | Remove orphaned tmux sessions |
| `/killall` | Kill all sessions (with confirmation) |

### System

| Command | Action |
|---------|--------|
| `/selfupdate` | Pull and rebuild Miranda |
| `/restart` | Graceful restart |
| `/ssh` | Get SSH command for manual access |

### Legacy ba Workflow (Deprecated)

> These commands use the ba task tracking system. For new projects, use the GitHub issue workflow above.

| Command | Action |
|---------|--------|
| `/mouse <task> [branch]` | Start mouse skill for ba task |
| `/drummer <project>` | Batch merge ba PRs (drummer-merge label) |
| `/notes <project> <pr>` | Address ba PR feedback |

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
2. Runs `sg init` (superego)

**Notes:**
- GitHub only (uses `gh` CLI)
- Reports partial success if clone works but init fails
- 10-minute clone timeout, 30-second per-tool init timeout

## Bootstrap Script

`scripts/bootstrap.sh` sets up Claude Code on a new machine after auth:

```bash
./scripts/bootstrap.sh [--skills-source <path>]
```

**What it installs:**

| Component | Source | Purpose |
|-----------|--------|---------|
| **Skills** | Copy from local or git repo | oh-plan, oh-task, oh-merge, oh-notes, dive-prep, playbook |
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
│   ├── oh-plan/SKILL.md
│   ├── oh-task/SKILL.md
│   ├── oh-merge/SKILL.md
│   ├── oh-notes/SKILL.md
│   └── ...
└── settings.json

# Also installed:
sg --version    # Superego
wm --version    # Working memory
```

## Deployment

### Option 1: User-level systemd (no root needed)

Best for dedicated user without sudo access.

```bash
# As the miranda user:

# Create user systemd directory
mkdir -p ~/.config/systemd/user

# Create service file
cat > ~/.config/systemd/user/miranda.service << 'EOF'
[Unit]
Description=Miranda - Telegram bot for remote Claude orchestration
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/miranda
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

Environment=NODE_ENV=production
Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=%h/.config/miranda/env

[Install]
WantedBy=default.target
EOF

# Create env file
mkdir -p ~/.config/miranda
cat > ~/.config/miranda/env << 'EOF'
TELEGRAM_BOT_TOKEN=xxx
ALLOWED_USER_IDS=123,456
PROJECTS_DIR=/home/miranda/projects
EOF

# Enable lingering (one-time, needs root)
sudo loginctl enable-linger miranda

# Start service
systemctl --user daemon-reload
systemctl --user enable miranda
systemctl --user start miranda
systemctl --user status miranda

# View logs
journalctl --user -u miranda -f
```

### Option 2: System-level systemd (template)

For running as any user via `miranda@<username>`.

```bash
# As root:
sudo cp ~/miranda/scripts/miranda.service /etc/systemd/system/miranda@.service
sudo systemctl daemon-reload

# Create env file for user
mkdir -p ~/.config/miranda
cat > ~/.config/miranda/env << 'EOF'
TELEGRAM_BOT_TOKEN=xxx
ALLOWED_USER_IDS=123,456
PROJECTS_DIR=/home/miranda/projects
EOF

# Enable and start
sudo systemctl enable miranda@miranda
sudo systemctl start miranda@miranda
sudo systemctl status miranda@miranda

# View logs
journalctl -u miranda@miranda -f
```
