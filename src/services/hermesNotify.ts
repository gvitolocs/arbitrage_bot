import type { BotConfig } from "../config.js";
import type { AlertPayload } from "../types.js";
import { logger } from "../logger.js";

export interface DigestPayload {
  periodStart: string;
  periodEnd: string;
  alerts: Array<{
    kind: string;
    title: string;
    message: string;
    poolName?: string;
    at: string;
  }>;
  transactions: Array<{ kind: string; status: string; tx_hash: string | null }>;
  stats: { alertCount: number; txCount: number; kinds: Record<string, number> };
}

/** Deliver via Hermes Flareon — instant alerts rare; daily digest is the default. */
export class HermesNotifyService {
  private readonly enabled: boolean;

  constructor(private readonly config: BotConfig) {
    this.enabled = Boolean(config.hermesAlertUrl && config.hermesAlertToken);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.hermesAlertToken}`,
    };
  }

  private baseUrl(): string {
    return this.config.hermesAlertUrl!.replace(/\/+$/, "");
  }

  async send(alert: AlertPayload): Promise<boolean> {
    logger.info({ kind: alert.kind, title: alert.title }, "Instant alert → Flareon");
    if (!this.enabled) return false;

    try {
      const res = await fetch(`${this.baseUrl()}/api/internal/guardian/alert`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          kind: alert.kind,
          title: alert.title,
          message: alert.message,
          poolName: alert.poolName,
          metadata: alert.metadata,
        }),
      });
      if (!res.ok) {
        logger.error({ status: res.status }, "Instant alert failed");
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, "Instant alert request failed");
      return false;
    }
  }

  async sendDigest(payload: DigestPayload): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const res = await fetch(`${this.baseUrl()}/api/internal/guardian/digest`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        logger.error({ status: res.status, body }, "Daily digest failed");
        return false;
      }
      if ((body as { skipped?: boolean }).skipped) {
        logger.info("Flareon digest skipped (nothing meaningful)");
        return true;
      }
      logger.info("Daily digest sent via Flareon");
      return true;
    } catch (err) {
      logger.error({ err }, "Daily digest request failed");
      return false;
    }
  }
}
