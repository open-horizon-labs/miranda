# Miranda

Telegram bot for remote Claude orchestration. The ractor who gives voice to the Primer.

> *Named after Miranda from Neal Stephenson's "The Diamond Age" - the ractor who voices the Young Lady's Illustrated Primer for Nell.*

## What is Miranda?

Miranda lets you orchestrate [oh-my-pi](https://github.com/open-horizon-labs/oh-my-pi) agent sessions from your phone via Telegram:

- **Start autonomous tasks** - Spawn agents that claim GitHub issues, work them in isolated branches, and create PRs
- **Answer questions remotely** - When the agent needs input, get a Telegram notification and respond via inline buttons
- **Batch merge PRs** - Review and merge multiple PRs as a cohesive batch
- **Address PR feedback** - Handle review comments autonomously
- **Monitor progress** - Check session status from anywhere

## Components

| Name | Role | Reference |
|------|------|-----------|
| **Miranda** | Telegram bot | The ractor who voices the Primer |
| **oh-plan** | Task planner | Investigates and creates GitHub issues |
| **oh-task** | Issue worker | Works GitHub issues autonomously |
| **oh-merge** | Batch merger | Merges GitHub issue PRs in rhythm |
| **oh-notes** | PR feedback | Addresses review comments |
| **jira-plan** | Jira planner | Creates Jira subtasks from context |

## Architecture

```
Phone <-> Telegram <-> Miranda <-> oh-my-pi agent processes (RPC mode)
                                       |
                                   JSON lines over stdin/stdout
```

Miranda spawns oh-my-pi in RPC mode as child processes and communicates via JSON lines:
- Agent questions arrive as `extension_ui_request` events on stdout
- User responses are sent as `extension_ui_response` commands on stdin
- Task completion is signaled via the `signal_completion` custom tool
- Process exit without completion signal is treated as an error

### Completion Signaling

Skills call the `signal_completion` custom tool as their final action. Miranda watches for `tool_execution_end` events where `toolName === "signal_completion"` and extracts the structured payload (`status`, `pr`, `error`, `blocker`, `message`). This tool is installed to `~/.claude/tools/` and auto-discovered by oh-my-pi.

## Prerequisites

### Server Requirements

| Requirement | Purpose | Install |
|-------------|---------|---------|
| **Node.js 20+** | Runs Miranda | [nodejs.org](https://nodejs.org) |
| **pnpm** | Package manager | `npm install -g pnpm` |
| **Bun** | Runs oh-my-pi agent | [bun.sh](https://bun.sh) |
| **oh-my-pi** | Agent runtime | `bun install -g @oh-my-pi/pi-coding-agent` |
| **gh CLI** | GitHub operations | [cli.github.com](https://cli.github.com) |
| **superego** | Code review | `cargo install sg` |

### Verify prerequisites

```bash
node --version      # >= 20
pnpm --version
bun --version
omp --version       # oh-my-pi CLI
gh auth status      # GitHub CLI, authenticated
sg --version        # superego
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/open-horizon-labs/miranda.git
cd miranda
pnpm install
pnpm build
```

### 2. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot, copy the token
3. Get your Telegram user ID from [@userinfobot](https://t.me/userinfobot)

### 3. Configure environment

```bash
mkdir -p ~/.config/miranda
cat > ~/.config/miranda/env << 'EOF'
TELEGRAM_BOT_TOKEN=<your-bot-token>
ALLOWED_USER_IDS=<your-telegram-id>
OMP_CLI_PATH=/home/<user>/.bun/bin/omp
PROJECTS_DIR=~/projects
PATH=/home/<user>/.bun/bin:/home/<user>/.cargo/bin:/home/<user>/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
```

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `OMP_CLI_PATH` | Yes | Path to oh-my-pi CLI binary (e.g., `/home/user/.bun/bin/omp`) |
| `PROJECTS_DIR` | No | Directory to scan for projects (default: `~/projects`) |
| `MIRANDA_HOME` | No | Override Miranda project root (default: derived from module location) |

### 4. Install the signal_completion tool

oh-my-pi discovers custom tools from `~/.claude/tools/`. The `signal_completion` tool must be installed there:

```bash
mkdir -p ~/.claude/tools
cp plugin/tools/signal-completion.ts ~/.claude/tools/signal-completion.ts
```

### 5. Deploy with systemd (user-level)

```bash
mkdir -p ~/.config/systemd/user

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
EnvironmentFile=%h/.config/miranda/env

[Install]
WantedBy=default.target
EOF

# Enable lingering so service runs without active login (needs root, one-time)
sudo loginctl enable-linger $(whoami)

# Start
systemctl --user daemon-reload
systemctl --user enable miranda
systemctl --user start miranda
systemctl --user status miranda
```

### View logs

```bash
journalctl --user -u miranda -f
```

## Development

```bash
pnpm install       # Install dependencies
pnpm dev           # Development with hot reload
pnpm build         # Build for production
pnpm typecheck     # Type checking
pnpm start         # Run production build
```

## Telegram Commands

### GitHub Issue Workflow

| Command | Action |
|---------|--------|
| `/ohplan <project> <description>` | Plan task and create GitHub issues |
| `/ohtask <project> <issue>... [--base branch]` | Work GitHub issue(s) autonomously |
| `/ohmerge <project>` | Batch merge PRs with `oh-merge` label |
| `/ohnotes <project> <pr>` | Address PR review feedback |

### Project Management

| Command | Action |
|---------|--------|
| `/projects` | List projects on server |
| `/newproject <repo>` | Clone GitHub repo and init sg |
| `/pull` | Pull all clean projects |
| `/reset <project>` | Hard reset project to origin (with confirmation) |

### Session Management

| Command | Action |
|---------|--------|
| `/status` | Show active sessions |
| `/stop <task>` | Kill a session |
| `/logs <task>` | Show recent output |
| `/cleanup` | Remove orphaned sessions |
| `/killall` | Kill all sessions (with confirmation) |

### System

| Command | Action |
|---------|--------|
| `/selfupdate` | Pull and rebuild Miranda |
| `/restart` | Graceful restart (systemd auto-restarts) |
| `/ssh` | Get SSH command for manual access |

## Project Structure

```
src/
├── index.ts           # Entry point, bot setup, callback routing
├── config.ts          # Environment configuration
├── types.ts           # Shared TypeScript types
├── bot/
│   ├── commands.ts    # Command handlers (/ohtask, /status, etc.)
│   └── keyboards.ts   # Inline keyboard builders and parsers
├── agent/
│   ├── process.ts     # oh-my-pi RPC process management
│   └── events.ts      # RPC event handlers (UI bridge, completion)
├── state/
│   └── sessions.ts    # SQLite session state management
└── projects/
    ├── scanner.ts     # Project discovery and git operations
    └── clone.ts       # Repository cloning

plugin/
├── skills/            # Skill definitions (SKILL.md files)
│   ├── oh-task/       # GitHub issue worker
│   ├── oh-plan/       # Issue planner
│   ├── oh-merge/      # Batch PR merger
│   ├── oh-notes/      # PR feedback handler
│   └── jira-plan/     # Jira subtask creator
└── tools/
    └── signal-completion.ts  # Custom tool for structured completion signaling

scripts/
├── bootstrap.sh       # Server setup script
└── miranda.service    # systemd template service file
```

## License

Source-available. See [LICENSE](LICENSE) for details.

## Related Projects

- [oh-my-pi](https://github.com/open-horizon-labs/oh-my-pi) - Agent runtime (spawned by Miranda)
- [Open Horizons](https://github.com/cloud-atlas-ai/open-horizons) - Strategic alignment platform
- [Superego](https://github.com/cloud-atlas-ai/superego) - Metacognitive advisor for AI assistants
