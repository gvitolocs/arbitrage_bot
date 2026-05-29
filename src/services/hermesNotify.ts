import type { BotConfig } from "../config.js";
import type { AlertPayload } from "../types.js";
import { logger } from "../logger.js";

/** Deliver alerts via Hermes Flareon on nespc (not a separate Telegram bot client). */
export class HermesNotifyService {
  private readonly enabled: boolean;

  constructor(private readonly config: BotConfig) {
    this.enabled = Boolean(config.hermesAlertUrl && config.hermesAlertToken);
    if (!this.enabled) {
      logger.warn(
        "Hermes alerts disabled — set HERMES_ALERT_URL and HERMES_ALERT_TOKEN (Flareon on nespc)"
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async send(alert: AlertPayload): Promise<boolean> {
    const text = [alert.title, alert.message, alert.poolName ? `Pool: ${alert.poolName}` : ""]
      .filter(Boolean)
      .join(" | ");
    logger.info({ kind: alert.kind, title: alert.title }, text);

    if (!this.enabled) return false;

    const url = `${this.config.hermesAlertUrl!.replace(/\/+$/, "")}/api/internal/guardian/alert`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.hermesAlertToken}`,
        },
        body: JSON.stringify({
          kind: alert.kind,
          title: alert.title,
          message: alert.message,
          poolName: alert.poolName,
          metadata: alert.metadata,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.error({ status: res.status, body }, "Hermes guardian alert failed");
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, "Hermes guardian alert request failed");
      return false;
    }
  }

  async sendStartupReport(summary: string): Promise<void> {
    await this.send({
      kind: "startup",
      title: "wPKN Guardian started",
      message: summary,
    });
  }
}
