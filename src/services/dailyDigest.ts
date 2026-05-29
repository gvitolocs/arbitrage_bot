import type { BotConfig } from "../config.js";
import type { BotDatabase } from "../db/index.js";
import type { HermesNotifyService } from "./hermesNotify.js";

export interface DigestStats {
  alertCount: number;
  txCount: number;
  kinds: Record<string, number>;
}

/** Routine price gaps are logged only — not a reason to ping Flareon. */
export function isMeaningfulDigest(
  alerts: Array<{ kind: string }>,
  txs: Array<{ status: string }>
): boolean {
  if (txs.length > 0) return true;
  const kinds = new Set(alerts.map((a) => a.kind));
  if (kinds.has("low_reserve")) return true;
  if (
    kinds.has("tx_failed") ||
    kinds.has("tx_success") ||
    kinds.has("rpc_failure") ||
    kinds.has("wallet_low_balance") ||
    kinds.has("gas_too_high")
  ) {
    return true;
  }
  return false;
}

export function shouldRunDigestNow(config: BotConfig, lastDigestAt: string | null): boolean {
  const now = new Date();
  if (now.getUTCHours() !== config.digestUtcHour) return false;

  if (!lastDigestAt) {
    return now.getUTCMinutes() < 20;
  }
  const last = new Date(lastDigestAt);
  const sameDay =
    last.getUTCFullYear() === now.getUTCFullYear() &&
    last.getUTCMonth() === now.getUTCMonth() &&
    last.getUTCDate() === now.getUTCDate();
  return !sameDay;
}

export class DailyDigestService {
  constructor(
    private readonly config: BotConfig,
    private readonly db: BotDatabase,
    private readonly hermes: HermesNotifyService
  ) {}

  async maybeRun(): Promise<void> {
    const last = this.db.getLastDigestAt();
    if (!shouldRunDigestNow(this.config, last)) return;

    const pending = this.db.getUndigestedAlerts();
    const since = last ?? new Date(Date.now() - 86_400_000).toISOString();
    const txs = this.db.getTransactionsSince(since);

    if (!isMeaningfulDigest(pending, txs)) {
      const batchId = `skip-${Date.now()}`;
      this.db.markAlertsDigested(
        pending.map((a) => a.id),
        batchId
      );
      this.db.setLastDigestAt(new Date().toISOString());
      return;
    }

    const stats: DigestStats = {
      alertCount: pending.length,
      txCount: txs.length,
      kinds: pending.reduce<Record<string, number>>((acc, a) => {
        acc[a.kind] = (acc[a.kind] ?? 0) + 1;
        return acc;
      }, {}),
    };

    const ok = await this.hermes.sendDigest({
      periodStart: since,
      periodEnd: new Date().toISOString(),
      alerts: pending.map((a) => ({
        kind: a.kind,
        title: a.title,
        message: a.message,
        poolName: a.pool_name ?? undefined,
        at: a.created_at,
      })),
      transactions: txs,
      stats,
    });

    if (ok) {
      const batchId = `digest-${Date.now()}`;
      this.db.markAlertsDigested(
        pending.map((a) => a.id),
        batchId
      );
      this.db.setLastDigestAt(new Date().toISOString());
    }
  }
}
