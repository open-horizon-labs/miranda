export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id)),
  hookPort: parseInt(process.env.MIRANDA_PORT ?? "3847", 10),
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
