# Miranda

Telegram bot for remote Claude orchestration. The ractor who gives voice to the Primer.

> *Named after Miranda from Neal Stephenson's "The Diamond Age" - the ractor who voices the Young Lady's Illustrated Primer for Nell.*

## What is Miranda?

Miranda lets you orchestrate Claude Code sessions from your phone via Telegram:

- **Start autonomous tasks** - Spawn Claude workers that claim tasks, work them in isolated branches, and create PRs
- **Answer questions remotely** - When Claude needs input, get a notification and respond via inline buttons
- **Batch merge PRs** - Review and merge multiple PRs as a cohesive batch
- **Monitor progress** - Check session status and logs from anywhere

## Components

| Name | Role | Reference |
|------|------|-----------|
| **Miranda** | Telegram bot | The ractor who voices the Primer |
| **Mouse** | Task worker | Small autonomous worker from the Mouse Army |
| **Drummer** | Batch merger | The collective that processes in rhythm |

## Claude Code Plugin

Miranda includes skills for Claude Code that can be installed via the plugin marketplace:

```bash
# Add the marketplace
claude plugin marketplace add cloud-atlas-ai/miranda

# Install the plugin
claude plugin install miranda@miranda
```

### Skills

**Mouse** (`mouse <task-id>`)
- Claims a ba task and works it to completion
- Creates isolated git worktree for each task
- Runs superego review before committing
- Creates PR when done, waits for CodeRabbit feedback
- Handles descendant tasks automatically

**Drummer** (`drummer`)
- Finds all PRs with `drummer-merge` label
- Runs holistic batch review across all changes
- Detects and handles stacked PRs
- Squash merges in dependency order

## Architecture

```
Phone ↔ Telegram ↔ Miranda ↔ tmux sessions (Claude /mouse)
                      ↑
                PreToolUse hook (notify-miranda.sh)
```

When Claude calls `AskUserQuestion`, a hook notifies Miranda, which sends a Telegram message with inline buttons. Your response is piped back to the tmux session.

## Setup

### Bot Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather)
2. Get your Telegram user ID (use [@userinfobot](https://t.me/userinfobot))
3. Configure environment:

```bash
cp .env.example .env
# Edit .env with your values:
# TELEGRAM_BOT_TOKEN=xxx
# ALLOWED_USER_IDS=123,456
```

### Server Setup

```bash
# Install dependencies
pnpm install

# Development
pnpm dev

# Production
pnpm build
pnpm start
```

### Claude Code Setup

On the server where Claude runs:

```bash
# Install the miranda plugin
claude plugin marketplace add cloud-atlas-ai/miranda
claude plugin install miranda@miranda

# Configure hook for notifications (in ~/.claude/settings.json)
# The plugin handles this automatically
```

## Telegram Commands

| Command | Action |
|---------|--------|
| `/mouse <task> [branch]` | Start mouse skill for a task |
| `/drummer` | Run batch merge |
| `/status` | Show active sessions |
| `/stop <task>` | Kill a session |
| `/logs <task>` | Show recent output |

## Dependencies

Miranda works best with these tools installed on the server:

- [ba](https://github.com/cloud-atlas-ai/ba) - Task tracking
- [superego](https://github.com/cloud-atlas-ai/superego) - Metacognitive code review
- [gh](https://cli.github.com/) - GitHub CLI for PR operations

## License

Source-available. See [LICENSE](LICENSE) for details.

## Related Projects

- [Open Horizons](https://github.com/cloud-atlas-ai/open-horizons) - Strategic alignment platform
- [Superego](https://github.com/cloud-atlas-ai/superego) - Metacognitive advisor for AI assistants
- [WM](https://github.com/cloud-atlas-ai/wm) - Working memory for AI assistants
