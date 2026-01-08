import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

function expandTilde(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Get Miranda's home directory.
 * Uses MIRANDA_HOME env var if set, otherwise derives from module location.
 * The module is at src/config.ts or dist/config.js, so we go up 2 levels.
 */
function getMirandaHome(): string {
  if (process.env.MIRANDA_HOME) {
    return expandTilde(process.env.MIRANDA_HOME);
  }
  // Derive from module location: __dirname equivalent in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Go up from src/ or dist/ to project root
  return resolve(__dirname, "..");
}

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id)),
  hookPort: parseInt(process.env.MIRANDA_PORT ?? "3847", 10),
  defaultProject: process.env.MIRANDA_DEFAULT_PROJECT ?? "",
  projectsDir: expandTilde(process.env.PROJECTS_DIR ?? "~/projects"),
  mirandaHome: getMirandaHome(),
} as const;

export function validateConfig(): void {
  if (!config.botToken) {
    console.error("TELEGRAM_BOT_TOKEN environment variable is required");
    process.exit(1);
  }
  if (isNaN(config.hookPort)) {
    console.error("MIRANDA_PORT must be a valid number");
    process.exit(1);
  }
  if (config.allowedUserIds.length === 0) {
    console.warn("Warning: ALLOWED_USER_IDS not set, bot will reject all users");
  }
}
