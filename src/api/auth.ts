import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Validate Telegram Mini App initData.
 *
 * The Mini App frontend sends initData (from Telegram.WebApp.initData) as the
 * x-telegram-init-data header. Server-side validation:
 * 1. Parse the query string
 * 2. Extract hash, sort remaining fields alphabetically
 * 3. HMAC-SHA-256: secret = HMAC("WebAppData", BOT_TOKEN), then HMAC(secret, check_string)
 * 4. Compare computed hash with received hash (timing-safe)
 * 5. Check auth_date freshness (1 hour window)
 * 6. Extract user.id, verify against ALLOWED_USER_IDS
 *
 * Returns the validated TelegramUser or null if validation fails.
 */
export function validateInitData(initData: string): TelegramUser | null {
  if (!initData) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get("hash");
  if (!hash) return null;

  // Build check string: all params except hash, sorted alphabetically, newline-joined
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // HMAC validation
  const secret = createHmac("sha256", "WebAppData")
    .update(config.botToken)
    .digest();
  const computed = createHmac("sha256", secret)
    .update(checkString)
    .digest("hex");

  // Timing-safe comparison
  if (computed.length !== hash.length) return null;
  const computedBuf = Buffer.from(computed, "hex");
  const hashBuf = Buffer.from(hash, "hex");
  if (computedBuf.length !== hashBuf.length) return null;
  if (!timingSafeEqual(computedBuf, hashBuf)) return null;

  // Check auth_date freshness (1 hour window)
  const authDate = parseInt(params.get("auth_date") ?? "0", 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > 3600) return null;

  // Extract and validate user
  const userStr = params.get("user");
  if (!userStr) return null;

  let user: TelegramUser;
  try {
    user = JSON.parse(userStr) as TelegramUser;
  } catch {
    return null;
  }

  if (typeof user.id !== "number") return null;

  // Check against allowed user IDs
  if (!config.allowedUserIds.includes(user.id)) return null;

  return user;
}
