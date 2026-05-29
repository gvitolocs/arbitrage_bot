import { createServer } from "node:http";
import { loadConfig, formatConfigSummary } from "./config.js";
import { ProviderManager } from "./blockchain/provider.js";
import { PoolReader } from "./blockchain/contracts.js";
import { SwapExecutor } from "./blockchain/executor.js";
import { BotDatabase } from "./db/index.js";
import { logStartupBanner, logger } from "./logger.js";
import { ArbitrageSimulator } from "./services/arbitrageSimulator.js";
import { LiquidityGuardian } from "./services/liquidityGuardian.js";
import { PoolMonitor } from "./services/poolMonitor.js";
import { SellRebalancer } from "./services/sellRebalancer.js";
import { HermesNotifyService } from "./services/hermesNotify.js";
import { DailyDigestService } from "./services/dailyDigest.js";
import { recordAlert } from "./services/alertJournal.js";
import type { AlertPayload } from "./types.js";

let shuttingDown = false;

async function main(): Promise<void> {
  const config = loadConfig();
  logStartupBanner(formatConfigSummary(config));

  const db = new BotDatabase(config.databasePath);
  const providerManager = new ProviderManager(config);
  const poolReader = new PoolReader(providerManager, config);
  const notifyService = new HermesNotifyService(config);
  const dailyDigest = new DailyDigestService(config, db, notifyService);
  const monitor = new PoolMonitor(config, poolReader, providerManager, db);
  const arbitrage = new ArbitrageSimulator(config, providerManager, db);
  const guardian = new LiquidityGuardian(config, poolReader, providerManager, db);
  const swapExecutor = new SwapExecutor(config, providerManager);
  const sellRebalancer = new SellRebalancer(
    config,
    poolReader,
    providerManager,
    swapExecutor,
    db
  );

  const healthServer = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: shuttingDown ? "shutting_down" : "ok",
          dryRun: config.dryRun,
          enableTrading: config.enableTrading,
          watchMode: "daily_digest",
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

  journal(notifyService, db, {
    kind: "startup",
    title: "Guardian online",
    message: formatConfigSummary(config),
  });

  const runTick = async (): Promise<void> => {
    if (shuttingDown) return;

    try {
      await dailyDigest.maybeRun();

      const cycle = await monitor.runCycle();

      console.log("\n=== wPKN Guardian — cycle ===");
      const gapLabel = cycle.priceGapActionable
        ? `${cycle.priceDiffPercent.toFixed(2)}% — rebalance toward ≤${config.targetPriceDiffPercent}%`
        : `${cycle.priceDiffPercent.toFixed(2)}% — within target`;
      console.log(`Price difference: ${gapLabel}`);
      for (const p of cycle.prices) {
        const geckoSpot = (p as { geckoPriceUsd?: number }).geckoPriceUsd;
        const px =
          p.priceUsd != null
            ? `$${p.priceUsd.toFixed(6)}`
            : p.priceQuotePerWpkn.toFixed(8);
        const geckoNote =
          geckoSpot != null && p.priceUsd != null && Math.abs(geckoSpot - p.priceUsd) > 0.0001
            ? ` | gecko-spot=$${geckoSpot.toFixed(4)} (index only)`
            : "";
        console.log(
          `[${p.poolName}] wPKN=${p.wpkenReserveHuman} | quote=${p.quoteReserveHuman} | price=${px}${geckoNote}`
        );
      }
      if (cycle.alerts.length) {
        console.log("Alerts (logged, not pinged):", cycle.alerts.join("; "));
      }

      const arb = await arbitrage.simulate(cycle.reserves);
      if (arb?.profitable) {
        journal(notifyService, db, {
          kind: "arbitrage_opportunity",
          title: "Arb sim",
          message: `${arb.direction}: ${arb.estimatedProfitQuoteHuman}`,
          metadata: { reason: arb.reason },
        });
      }

      const sellPlan = await sellRebalancer.plan(
        cycle.reserves,
        cycle.prices,
        cycle.geckoPools
      );
      if (sellPlan) {
        console.log(`Sell plan [${sellPlan.venue}]: ${sellPlan.reason}`);
        if (sellPlan.shouldSell && config.enableTrading && !config.dryRun) {
          try {
            const hash = await sellRebalancer.execute(sellPlan, cycle.reserves[0]!);
            await journal(notifyService, db, {
              kind: "tx_success",
              title: "Sold wPKN",
              message: `tx ${hash}`,
              poolName: sellPlan.poolName,
            });
          } catch (err) {
            await journal(notifyService, db, {
              kind: "tx_failed",
              title: "Sell failed",
              message: err instanceof Error ? err.message : String(err),
              poolName: sellPlan.poolName,
            });
          }
        } else if (sellPlan.shouldSell) {
          journal(notifyService, db, {
            kind: "arbitrage_opportunity",
            title: "Would sell wPKN",
            message: sellPlan.reason,
            poolName: sellPlan.poolName,
          });
        }
      }

      for (const plan of await guardian.planRefills(cycle.reserves, cycle.geckoPools)) {
        journal(notifyService, db, {
          kind: "liquidity_refill_suggestion",
          title: "Low reserve plan",
          message: plan.blockReason ?? "refill planned",
          poolName: plan.poolName,
        });
      }

      for (const alert of cycle.alerts) {
        if (alert.includes("Price diff")) {
          journal(notifyService, db, {
            kind: "price_divergence",
            title: "Price divergence",
            message: alert,
          });
        }
        if (alert.includes("below min")) {
          journal(notifyService, db, {
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
      journal(notifyService, db, {
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
    clearInterval(interval);
    healthServer.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function journal(
  hermes: HermesNotifyService,
  db: BotDatabase,
  alert: AlertPayload
): void {
  const { saved, instant } = recordAlert(db, alert);
  if (saved && instant) {
    void hermes.send(alert);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
