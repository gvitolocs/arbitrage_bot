import type { BotDatabase } from "../db/index.js";
import type { AlertKind, AlertPayload } from "../types.js";

/** Kinds that never ping Flareon immediately — batched into daily digest only. */
const DIGEST_ONLY: Set<AlertKind> = new Set([
  "startup",
  "price_divergence",
  "arbitrage_opportunity",
  "liquidity_refill_suggestion",
  "low_reserve",
  "stale_pool",
]);

/** Immediate Flareon ping (trades / hard failures). */
const INSTANT_KINDS: Set<AlertKind> = new Set([
  "tx_success",
  "tx_failed",
  "gas_too_high",
  "wallet_low_balance",
]);

export function shouldNotifyInstant(kind: AlertKind): boolean {
  return INSTANT_KINDS.has(kind);
}

export function isDigestOnly(kind: AlertKind): boolean {
  return DIGEST_ONLY.has(kind);
}

export function recordAlert(
  db: BotDatabase,
  alert: AlertPayload,
  dedupeMinutes = 360
): { saved: boolean; instant: boolean } {
  const instant = shouldNotifyInstant(alert.kind);
  const dedupeKey = instant
    ? `${alert.kind}:${alert.title}:${alert.message}`
    : alert.message;
  const windowMin = instant && alert.kind === "tx_failed" ? 60 : dedupeMinutes;
  if (db.hasRecentAlert(alert.kind, dedupeKey, windowMin)) {
    return { saved: false, instant: false };
  }
  db.saveAlert(alert, instant);
  return { saved: true, instant };
}
