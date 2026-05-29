import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  transport: isDev
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      }
    : undefined,
  redact: {
    paths: [
      "privateKey",
      "PRIVATE_KEY",
      "env.PRIVATE_KEY",
      "telegramBotToken",
      "TELEGRAM_BOT_TOKEN",
    ],
    censor: "[REDACTED]",
  },
});

export function logStartupBanner(configSummary: string): void {
  logger.info({ config: configSummary }, "wPKN Liquidity Guardian starting");
  logger.warn(
    "DRY_RUN mode: no transactions will be sent unless ENABLE_TRADING/ENABLE_AUTO_LIQUIDITY and DRY_RUN=false"
  );
}
