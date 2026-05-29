import { createServer } from "node:http";
import { loadConfig, formatConfigSummary } from "./config.js";
import { ProviderManager } from "./blockchain/provider.js";
import { PoolReader } from "./blockchain/contracts.js";
import { BotDatabase } from "./db/index.js";
import { logStartupBanner, logger } from "./logger.js";
import { ArbitrageSimulator } from "./services/arbitrageSimulator.js";
import { LiquidityGuardian } from "./services/liquidityGuardian.js";
import { PoolMonitor } from "./services/poolMonitor.js";
import { TelegramService } from "./services/telegram.js";
import type { AlertPayload } from "./types.js";

let shuttingDown = false;

async function main(): Promise<void> {
  const config = loadConfig();
  logStartupBanner(formatConfigSummary(config));

  const db = new BotDatabase(config.databasePath);
  const providerManager = new ProviderManager(config);
  const poolReader = new PoolReader(providerManager, config);
  const telegram = new TelegramService(config);
  const monitor = new PoolMonitor(config, poolReader, db);
  const arbitrage = new ArbitrageSimulator(config, providerManager, db);
  const guardian = new LiquidityGuardian(config, poolReader, providerManager, db);

  const healthServer = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: shuttingDown ? "shutting_down" : "ok",
          dryRun: config.dryRun,
          enableTrading: config.enableTrading,
          enableAutoLiquidity: config.enableAutoLiquidity,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  healthServer.listen(config.healthPort, () => {
    logger.info({ port: config.healthPort }, "Health server listening");
  });

  await telegram.sendStartupReport(formatConfigSummary(config));

  const runTick = async (): Promise<void> => {
    if (shuttingDown) return;

    try {
      const cycle = await monitor.runCycle();

      console.log("\n=== wPKN Liquidity Guardian — cycle ===");
      console.log(`Price difference: ${cycle.priceDiffPercent.toFixed(2)}%`);
      for (const p of cycle.prices) {
        console.log(
          `[${p.poolName}] wPKN=${p.wpkenReserveHuman} | quote=${p.quoteReserveHuman} | price=${p.priceQuotePerWpkn.toFixed(8)} ${p.stale ? "(STALE?)" : ""}`
        );
      }
      if (cycle.alerts.length) {
        console.log("Alerts:", cycle.alerts.join("; "));
      } else {
        console.log("Alerts: none");
      }

      const arb = await arbitrage.simulate(cycle.reserves);
      if (arb) {
        console.log(
          `Arbitrage sim: profitable=${arb.profitable} dir=${arb.direction} net=${arb.estimatedProfitQuoteHuman} | ${arb.reason}`
        );
        if (arb.profitable) {
          await notify(telegram, db, {
            kind: "arbitrage_opportunity",
            title: "Arb opportunity (sim)",
            message: `${arb.direction}: est. ${arb.estimatedProfitQuoteHuman} quote`,
            metadata: { reason: arb.reason },
          });
        }
      }

      const plans = await guardian.planRefills(cycle.reserves);
      for (const plan of plans) {
        console.log(
          `Refill ${plan.poolName}: +${plan.wpkenToAdd} wPKN + quote | execute=${plan.canExecute} ${plan.blockReason ?? ""}`
        );
        await notify(telegram, db, {
          kind: "liquidity_refill_suggestion",
          title: "Low wPKN reserve",
          message: `Add ~${plan.wpkenToAdd} wPKN. ${plan.blockReason ?? "Ready (still disabled until enabled)"}`,
          poolName: plan.poolName,
        });
      }

      for (const alert of cycle.alerts) {
        if (alert.includes("Price diff")) {
          await notify(telegram, db, {
            kind: "price_divergence",
            title: "Price divergence",
            message: alert,
          });
        }
        if (alert.includes("below min")) {
          await notify(telegram, db, {
            kind: "low_reserve",
            title: "Low reserve",
            message: alert,
            poolName: alert.split(":")[0],
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Monitor cycle failed");
      await notify(telegram, db, {
        kind: "rpc_failure",
        title: "Cycle error",
        message: msg,
      });
    }
  };

  await runTick();
  const interval = setInterval(runTick, config.pollIntervalSeconds * 1000);

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down gracefully");
    clearInterval(interval);
    healthServer.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function notify(
  telegram: TelegramService,
  db: BotDatabase,
  alert: AlertPayload
): Promise<void> {
  db.saveAlert(alert);
  await telegram.send(alert);
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
