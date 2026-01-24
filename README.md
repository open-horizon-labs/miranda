# Miranda

Telegram bot for remote Claude orchestration. The ractor who gives voice to the Primer.

> *Named after Miranda from Neal Stephenson's "The Diamond Age" - the ractor who voices the Young Lady's Illustrated Primer for Nell.*

## What is Miranda?

Miranda lets you orchestrate Claude Code sessions from your phone via Telegram:

- **Start autonomous tasks** - Spawn Claude workers that claim GitHub issues, work them in isolated branches, and create PRs
- **Answer questions remotely** - When Claude needs input, get a notification and respond via inline buttons
- **Batch merge PRs** - Review and merge multiple PRs as a cohesive batch
- **Address PR feedback** - Handle review comments autonomously
- **Monitor progress** - Check session status and logs from anywhere

## Components

| Name | Role | Reference |
|------|------|-----------|
| **Miranda** | Telegram bot | The ractor who voices the Primer |
| **oh-plan** | Task planner | Investigates and creates GitHub issues |
| **oh-task** | Issue worker | Works GitHub issues autonomously |
| **oh-merge** | Batch merger | Merges GitHub issue PRs in rhythm |
| **oh-notes** | PR feedback | Addresses review comments |

## Claude Code Plugin

Miranda includes skills for Claude Code that can be installed via the plugin marketplace:

```bash
# Add the marketplace
claude plugin marketplace add cloud-atlas-ai/miranda

# Install the plugin
claude plugin install miranda@miranda
```

### Skills

#### GitHub Issue Workflow (Recommended)

**oh-plan** (`oh-plan '<task description>'`)
- Takes a high-level task description
- Investigates the codebase for relevant files and patterns
- Asks clarifying questions via AskUserQuestion
- Creates GitHub issue(s) with `oh-planned` label
- Issues are ready for oh-task to work on

**oh-task** (`oh-task <issue-number> [base-branch]`)
- Claims a GitHub issue and works it to completion
- Creates isolated git worktree on `issue/<number>` branch
- Runs superego review before committing
- Creates PR with "Closes #N" for auto-close
- Handles stacked PRs when base-branch is specified

**oh-merge** (`oh-merge`)
- Finds all PRs with `oh-merge` label
- Runs holistic batch review across all changes
- Detects and handles stacked PRs
- Squash merges in dependency order
- GitHub auto-closes linked issues

**oh-notes** (`oh-notes <pr-number>`)
- Addresses review comments on GitHub issue PRs
- Creates GitHub issues for descendant tasks (from sg review findings)
- Works in isolated worktree, pushes fixes

#### Legacy ba Workflow (Deprecated)

> **Note:** The ba-based skills are deprecated. Use the GitHub issue workflow above for new projects.

**mouse** (`mouse <task-id> [base-branch]`) - *Deprecated*
- Claims a ba task and works it to completion
- Use `oh-task` instead for GitHub issue-based workflow

**drummer** (`drummer`) - *Deprecated*
- Finds all PRs with `drummer-merge` label
- Use `oh-merge` instead for GitHub issue-based workflow

**notes** (`notes <pr-number>`) - *Deprecated*
- Addresses review comments on ba task PRs
- Use `oh-notes` instead for GitHub issue-based workflow

## Architecture

```
Phone <-> Telegram <-> Miranda <-> tmux sessions (Claude /oh-task)
                          ^
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

### GitHub Issue Workflow

| Command | Action |
|---------|--------|
| `/ohplan <project> <description>` | Plan task and create GitHub issues |
| `/ohtask <project> <issue> [branch]` | Start oh-task skill for GitHub issue |
| `/ohmerge <project>` | Batch merge GitHub issue PRs (oh-merge label) |
| `/ohnotes <project> <pr>` | Address GitHub issue PR feedback |

### Project Management

| Command | Action |
|---------|--------|
| `/projects` | List projects on server with task counts |
| `/tasks <project>` | List tasks for a project |
| `/newproject <repo>` | Clone GitHub repo and init sg |
| `/pull` | Pull all clean projects |

### Session Management

| Command | Action |
|---------|--------|
| `/status` | Show active sessions |
| `/stop <task>` | Kill a session |
| `/logs <task>` | Show recent output |
| `/cleanup` | Remove orphaned sessions |
| `/killall` | Kill all sessions |

### System

| Command | Action |
|---------|--------|
| `/selfupdate` | Pull and rebuild Miranda |
| `/restart` | Graceful restart |
| `/reset <project>` | Hard reset project to origin |
| `/ssh` | Get SSH command |

### Legacy (Deprecated)

| Command | Action |
|---------|--------|
| `/mouse <task> [branch]` | Start mouse skill for ba task |
| `/drummer <project>` | Batch merge ba PRs |
| `/notes <project> <pr>` | Address ba PR feedback |

## Dependencies

Miranda works best with these tools installed on the server:

- [superego](https://github.com/cloud-atlas-ai/superego) - Metacognitive code review
- [gh](https://cli.github.com/) - GitHub CLI for PR and issue operations
- [ba](https://github.com/cloud-atlas-ai/ba) - Task tracking (only for legacy workflow)

## License

Source-available. See [LICENSE](LICENSE) for details.

## Related Projects

- [Open Horizons](https://github.com/cloud-atlas-ai/open-horizons) - Strategic alignment platform
- [Superego](https://github.com/cloud-atlas-ai/superego) - Metacognitive advisor for AI assistants
- [WM](https://github.com/cloud-atlas-ai/wm) - Working memory for AI assistants
