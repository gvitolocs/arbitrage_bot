import type { BotConfig } from "../config.js";
import type { AlertPayload } from "../types.js";
import { logger } from "../logger.js";

export class TelegramService {
  private readonly enabled: boolean;

  constructor(private readonly config: BotConfig) {
    this.enabled = Boolean(config.telegramBotToken && config.telegramChatId);
    if (!this.enabled) {
      logger.warn("Telegram not configured — alerts will be logged only");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  formatAlert(alert: AlertPayload): string {
    const lines = [`<b>${escapeHtml(alert.title)}</b>`, escapeHtml(alert.message)];
    if (alert.poolName) lines.push(`Pool: ${escapeHtml(alert.poolName)}`);
    if (alert.metadata) {
      for (const [k, v] of Object.entries(alert.metadata)) {
        lines.push(`${escapeHtml(k)}: ${escapeHtml(String(v))}`);
      }
    }
    return lines.join("\n");
  }

  async send(alert: AlertPayload): Promise<boolean> {
    const text = this.formatAlert(alert);
    logger.info({ kind: alert.kind, title: alert.title }, text);

    if (!this.enabled) return false;

    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.error({ status: res.status, body }, "Telegram API error");
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, "Failed to send Telegram message");
      return false;
    }
  }

  async sendStartupReport(summary: string): Promise<void> {
    await this.send({
      kind: "startup",
      title: "Guardian started",
      message: summary,
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
