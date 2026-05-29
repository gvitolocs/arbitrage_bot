import type { BotConfig } from "../config.js";
import { PoolReader } from "../blockchain/contracts.js";
import { calculatePrice, formatUnits, percentDifference } from "../dex/uniswapV2Math.js";
import type { BotDatabase } from "../db/index.js";
import type { PoolConfig, PoolPrice, PoolReserves } from "../types.js";
import { logger } from "../logger.js";

export interface MonitorCycleResult {
  reserves: PoolReserves[];
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
    const prices: PoolPrice[] = [];
    const alerts: string[] = [];

    for (const pool of this.config.pools) {
      const r = await this.poolReader.readPoolReserves(pool);
      reserves.push(r);

      const priceQuotePerWpkn = calculatePrice(
        r.wpknReserve,
        r.quoteReserve,
        18,
        r.quoteToken.decimals
      );
      const priceWpknPerQuote =
        priceQuotePerWpkn > 0 ? 1 / priceQuotePerWpkn : 0;

      const prev = this.lastReserveByPool.get(r.poolAddress);
      const changeBps =
        prev && prev > 0n
          ? Number(((r.wpknReserve - prev) * 10_000n) / prev)
          : 0;
      const suspiciousChange = Math.abs(changeBps) > 2000;

      const state = this.db.getPoolState(r.poolAddress);
      const stale =
        state !== null &&
        r.blockNumber - state.lastBlock > 100 &&
        r.wpknReserve === state.lastReserveWpkn;

      if (r.wpknReserve < this.config.minWpkenReservePerPool) {
        alerts.push(
          `${r.poolName}: wPKN reserve ${formatUnits(r.wpknReserve, 18)} below min`
        );
      }

      this.db.saveReserveSnapshot(r, priceQuotePerWpkn);
      this.db.updatePoolState(r.poolAddress, r.blockNumber, r.wpknReserve);
      this.lastReserveByPool.set(r.poolAddress, r.wpknReserve);

      prices.push({
        poolAddress: r.poolAddress,
        poolName: r.poolName,
        priceQuotePerWpkn,
        priceWpknPerQuote,
        wpkenReserveHuman: formatUnits(r.wpknReserve, 18),
        quoteReserveHuman: formatUnits(r.quoteReserve, r.quoteToken.decimals),
        stale,
        suspiciousChange,
      });

      logger.info(
        {
          pool: r.poolName,
          wpkn: formatUnits(r.wpknReserve, 18),
          quote: formatUnits(r.quoteReserve, r.quoteToken.decimals),
          quoteSymbol: r.quoteToken.symbol,
          price: priceQuotePerWpkn,
          stale,
        },
        "Pool snapshot"
      );
    }

    let priceDiffPercent = 0;
    if (prices.length >= 2) {
      priceDiffPercent = percentDifference(
        prices[0]!.priceQuotePerWpkn,
        prices[1]!.priceQuotePerWpkn
      );
      if (priceDiffPercent >= this.config.priceDiffAlertPercent) {
        alerts.push(
          `Price diff ${priceDiffPercent.toFixed(2)}% between ${prices[0]!.poolName} and ${prices[1]!.poolName}`
        );
      }
    }

    return { reserves, prices, priceDiffPercent, alerts };
  }
}

export function getPoolFee(config: BotConfig, pool: PoolConfig): number {
  return pool.feeBps ?? config.defaultPoolFeeBps;
}
