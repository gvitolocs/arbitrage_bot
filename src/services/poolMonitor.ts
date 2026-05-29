import type { BotConfig } from "../config.js";
import { PoolReader } from "../blockchain/contracts.js";
import { calculatePrice, formatUnits, percentDifference } from "../dex/uniswapV2Math.js";
import type { BotDatabase } from "../db/index.js";
import type { PoolConfig, PoolPrice, PoolReserves } from "../types.js";
import { logger } from "../logger.js";
import { fetchPoolByAddress, type GeckoPoolSnapshot } from "./geckoTerminal.js";

export interface MonitorCycleResult {
  reserves: PoolReserves[];
  geckoPools: GeckoPoolSnapshot[];
  prices: PoolPrice[];
  priceDiffPercent: number;
  alerts: string[];
}

export class PoolMonitor {
  private lastReserveByPool = new Map<string, bigint>();

  constructor(
    private readonly config: BotConfig,
    private readonly poolReader: PoolReader,
    private readonly db: BotDatabase
  ) {}

  async runCycle(): Promise<MonitorCycleResult> {
    const reserves: PoolReserves[] = [];
    const geckoPools: GeckoPoolSnapshot[] = [];
    const prices: PoolPrice[] = [];
    const alerts: string[] = [];

    for (const pool of this.config.pools) {
      if (pool.kind === "gecko") {
        try {
          const g = await fetchPoolByAddress(this.config.geckoNetwork, pool.address);
          geckoPools.push(g);
          prices.push({
            poolAddress: pool.address,
            poolName: pool.name,
            priceQuotePerWpkn: 0,
            priceWpknPerQuote: 0,
            priceUsd: g.priceUsd,
            wpkenReserveHuman: "n/a (v4)",
            quoteReserveHuman: `$${g.reserveUsd.toFixed(2)}`,
            stale: g.reserveUsd < 1,
            suspiciousChange: false,
          });
          if (g.reserveUsd < 1) {
            alerts.push(`${pool.name}: Gecko shows very low liquidity ($${g.reserveUsd})`);
          }
        } catch (err) {
          logger.warn({ pool: pool.name, err }, "Gecko pool fetch failed");
          alerts.push(`${pool.name}: could not read Gecko price`);
        }
        continue;
      }

      try {
        const r = await this.poolReader.readPoolReserves(pool);
        reserves.push(r);

        const wpkenDecimals = r.token0.address.toLowerCase() === this.config.wpkenAddress.toLowerCase()
          ? r.token0.decimals
          : r.token1.decimals;

        const priceQuotePerWpkn = calculatePrice(
          r.wpknReserve,
          r.quoteReserve,
          wpkenDecimals,
          r.quoteToken.decimals
        );

        const prev = this.lastReserveByPool.get(r.poolAddress);
        const changeBps =
          prev && prev > 0n ? Number(((r.wpknReserve - prev) * 10_000n) / prev) : 0;
        const suspiciousChange = Math.abs(changeBps) > 2000;

        const state = this.db.getPoolState(r.poolAddress);
        const stale =
          state !== null &&
          r.blockNumber - state.lastBlock > 100 &&
          r.wpknReserve === state.lastReserveWpkn;

        if (r.wpknReserve < this.config.minWpkenReservePerPool) {
          alerts.push(
            `${r.poolName}: wPKN ${formatUnits(r.wpknReserve, wpkenDecimals)} < min ${formatUnits(this.config.minWpkenReservePerPool, wpkenDecimals)}`
          );
        }

        this.db.saveReserveSnapshot(r, priceQuotePerWpkn);
        this.db.updatePoolState(r.poolAddress, r.blockNumber, r.wpknReserve);
        this.lastReserveByPool.set(r.poolAddress, r.wpknReserve);

        let priceUsd: number | undefined;
        try {
          const g = await fetchPoolByAddress(this.config.geckoNetwork, r.poolAddress);
          priceUsd = g.priceUsd;
        } catch {
          /* optional */
        }

        prices.push({
          poolAddress: r.poolAddress,
          poolName: r.poolName,
          priceQuotePerWpkn,
          priceWpknPerQuote: priceQuotePerWpkn > 0 ? 1 / priceQuotePerWpkn : 0,
          priceUsd,
          wpkenReserveHuman: formatUnits(r.wpknReserve, wpkenDecimals),
          quoteReserveHuman: formatUnits(r.quoteReserve, r.quoteToken.decimals),
          stale,
          suspiciousChange,
        });

        logger.info(
          {
            pool: r.poolName,
            wpkn: formatUnits(r.wpknReserve, wpkenDecimals),
            price: priceQuotePerWpkn,
          },
          "V2 pool snapshot"
        );
      } catch (err) {
        logger.error({ pool: pool.name, err }, "V2 pool read failed");
        alerts.push(`${pool.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let priceDiffPercent = 0;
    const usdPrices = prices.filter((p) => p.priceUsd != null).map((p) => p.priceUsd!);
    if (usdPrices.length >= 2) {
      priceDiffPercent = percentDifference(usdPrices[0]!, usdPrices[1]!);
    } else if (prices.length >= 2) {
      priceDiffPercent = percentDifference(
        prices[0]!.priceQuotePerWpkn,
        prices[1]!.priceQuotePerWpkn
      );
    }

    if (priceDiffPercent >= this.config.priceDiffAlertPercent && prices.length >= 2) {
      alerts.push(
        `Price diff ${priceDiffPercent.toFixed(1)}%: ${prices[0]!.poolName} vs ${prices[1]!.poolName}`
      );
    }

    return { reserves, geckoPools, prices, priceDiffPercent, alerts };
  }
}

export function getPoolFee(config: BotConfig, pool: PoolConfig): number {
  return pool.feeBps ?? config.defaultPoolFeeBps;
}
