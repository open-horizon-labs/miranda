# Copilot Coding Agent Instructions

## Project Overview

Miranda is a Telegram bot for remote Claude orchestration, named after the ractor who voices the Primer in Neal Stephenson's "The Diamond Age". It enables remote control of Claude Code sessions via Telegram, allowing users to start autonomous tasks, answer questions, batch merge PRs, and monitor progress from anywhere.

## Architecture

- **Telegram Bot**: Built with Grammy (Telegram Bot API framework)
- **Session Management**: Tracks tmux sessions running Claude Code
- **Hook Server**: HTTP server on port 3847 that receives notifications from Claude via PreToolUse hooks
- **State Persistence**: SQLite database for session tracking
- **Project Discovery**: Scans directories for ba (task tracking) projects

## Build and Development

### Prerequisites

- Node.js 20+
- pnpm package manager
- TypeScript 5.3+

### Setup

```bash
# Install dependencies
pnpm install

# Copy environment configuration
cp .env.example .env
# Edit .env with:
# - TELEGRAM_BOT_TOKEN (from @BotFather)
# - ALLOWED_USER_IDS (comma-separated Telegram user IDs)
# - MIRANDA_PORT (optional, default: 3847)
# - PROJECTS_DIR (optional, default: ~/projects)
```

### Development Workflow

```bash
# Development with hot reload
pnpm dev

# Type checking
pnpm typecheck

# Build for production
pnpm build

# Run production build
pnpm start
```

### Important Commands

- `pnpm dev` - Start development server with tsx watch mode
- `pnpm build` - Compile TypeScript to JavaScript in `dist/` directory
- `pnpm typecheck` - Run TypeScript type checking without emitting files
- `pnpm lint` - Lint script defined but ESLint not yet configured

## Code Structure

```
src/
├── index.ts           # Entry point, bot setup, callback handlers
├── config.ts          # Environment configuration
├── types.ts           # Shared TypeScript types
├── bot/
│   ├── commands.ts    # Command handlers (/mouse, /status, etc.)
│   └── keyboards.ts   # Inline keyboard builders
├── hooks/
│   └── server.ts      # HTTP server for Claude hook notifications
├── projects/
│   └── discovery.ts   # ba project and task discovery
├── state/
│   └── sessions.ts    # SQLite session management
├── tmux/
│   └── sessions.ts    # tmux session control
└── utils/
    └── telegram.ts    # Telegram message formatting
```

## TypeScript Configuration

- **Target**: ES2022
- **Module System**: NodeNext (ESM with .js extensions in imports)
- **Strict Mode**: Enabled
- All imports must use `.js` extension (e.g., `import { x } from "./config.js"`)
- Output directory: `dist/`
- Source directory: `src/`

## Key Dependencies

- **grammy**: Telegram Bot API framework - used for all bot interactions
- **better-sqlite3**: SQLite database for state persistence
- **tsx**: TypeScript execution and watch mode for development

## Code Conventions

### TypeScript Types

- Use explicit types for function parameters and return values
- Define shared types in `types.ts`
- Use interfaces for object shapes (e.g., `Session`, `HookNotification`)
- Prefer `type` for unions and simple aliases

### Error Handling

- Catch errors in async operations
- Log errors to console with context
- Use best-effort error recovery for non-critical operations (e.g., Telegram message editing)
- Return appropriate error messages to users via Telegram

### Module Imports

- Always use `.js` extension in imports (TypeScript ESM requirement)
- Use absolute imports from project root where appropriate
- Keep imports organized: external dependencies first, then internal modules

### Async/Await

- Use async/await for all asynchronous operations
- Handle promise rejections appropriately
- Use `.catch()` for best-effort operations that shouldn't block

## Bot Commands

Commands are registered in `src/bot/commands.ts`:

- `/mouse <task>` - Start mouse skill for a task in a tmux session
- `/drummer` - Run batch merge skill
- `/projects` - List all ba projects with inline keyboard selection
- `/tasks <project>` - List tasks for a project
- `/status` - Show all active tmux sessions
- `/stop <task>` - Kill a specific tmux session
- `/logs <task>` - Show recent output from a session
- `/cleanup` - Remove orphaned sessions from database

## Session Management

Sessions represent tmux sessions running Claude Code:

- Tracked in SQLite database via `state/sessions.ts`
- Each session has: `taskId`, `tmuxName`, `chatId`, `status`, `pendingQuestion`
- Status values: `running`, `waiting_input`, `completed`, `failed`, `blocked`
- Sessions are automatically cleaned up on completion

## Hook Integration

- Miranda runs an HTTP server on port 3847 (configurable via `MIRANDA_PORT`)
- Claude Code hooks POST notifications to `/notify` endpoint
- Hook payload includes: `session`, `tool`, `input` (with questions array)
- Miranda sends questions to Telegram with inline keyboards
- User responses are sent back to tmux via `tmux send-keys`

## Testing

Currently, there is no test infrastructure in this repository. When adding tests:

- Use a testing framework compatible with TypeScript and ESM (e.g., vitest)
- Test files should be named `*.test.ts` or `*.spec.ts`
- Focus on testing core logic: session management, keyboard building, notification handling
- Mock external dependencies (Telegram API, tmux commands, file system)

## Security Considerations

- User authentication via `ALLOWED_USER_IDS` environment variable
- All bot interactions check user ID before processing
- Sensitive data (bot token, user IDs) in environment variables only
- No secrets should be committed to the repository

## Review Requirements

- Code must pass TypeScript type checking (`pnpm typecheck`)
- All functions should have clear, descriptive names
- Error handling should be comprehensive
- Changes to bot commands should be tested manually via Telegram
- Changes to session management should preserve data integrity
- Environment variable changes should be reflected in `.env.example`

## Dependencies to Avoid

- Do not add testing frameworks unless explicitly requested
- Keep dependencies minimal - this is a focused utility bot
- If adding ESLint, coordinate with the maintainers first

## Common Patterns

### Sending Telegram Messages

```typescript
await bot.api.sendMessage(chatId, "Message text", {
  parse_mode: "Markdown",
  reply_markup: inlineKeyboard,
});
```

### Inline Keyboards

```typescript
import { InlineKeyboard } from "grammy";

const keyboard = new InlineKeyboard()
  .text("Option 1", "callback_data_1")
  .text("Option 2", "callback_data_2");
```

### tmux Operations

```typescript
import { sendKeys, listTmuxSessions } from "./tmux/sessions.js";

// Send input to tmux session
await sendKeys("session-name", "text to send");

// List active sessions
const sessions = await listTmuxSessions();
```

### Session State

```typescript
import { getSession, setSession, deleteSession } from "./state/sessions.js";

// Retrieve session
const session = getSession("task-id");

// Update session
if (session) {
  session.status = "completed";
  setSession("task-id", session);
}

// Remove session
deleteSession("task-id");
```

## Diamond Age Theme

This project follows naming conventions from Neal Stephenson's "The Diamond Age":

- **Miranda**: The ractor who voices the Primer (this bot)
- **Mouse**: Task worker skill (autonomous Claude sessions)
- **Drummer**: Batch merge skill (collective PR processing)

When adding features or naming components, consider maintaining this thematic consistency where appropriate.
