import type { BotConfig } from "../config.js";
import { SwapExecutor } from "../blockchain/executor.js";
import { formatUnits, percentDifference } from "../dex/uniswapV2Math.js";
import type { BotDatabase } from "../db/index.js";
import type { GeckoPoolSnapshot } from "./geckoTerminal.js";
import type { PoolPrice, PoolReserves } from "../types.js";
import { logger } from "../logger.js";

export interface SellRebalancePlan {
  shouldSell: boolean;
  poolName: string;
  amountWpkn: bigint;
  reason: string;
}

/** Lower price on expensive Pancake pool by selling wPKN — never buys wPKN. */
export class SellRebalancer {
  constructor(
    private readonly config: BotConfig,
    private readonly executor: SwapExecutor,
    private readonly db: BotDatabase
  ) {}

  plan(
    v2Reserves: PoolReserves[],
    prices: PoolPrice[],
    geckoPools: GeckoPoolSnapshot[]
  ): SellRebalancePlan | null {
    if (v2Reserves.length === 0) return null;
    const v2 = v2Reserves[0]!;

    const pancakeUsd =
      prices.find((p) => p.poolAddress === v2.poolAddress)?.priceUsd ??
      geckoPools.find((g) => g.poolAddress.toLowerCase() === v2.poolAddress.toLowerCase())
        ?.priceUsd;

    const v2Price = prices.find((p) => p.poolAddress === v2.poolAddress);
    const pancakeUsdEst =
      pancakeUsd ??
      (v2Price && v2Price.priceQuotePerWpkn > 0
        ? v2Price.priceQuotePerWpkn * 630
        : undefined);

    const otherUsd =
      geckoPools.find((g) => g.poolAddress !== v2.poolAddress.toLowerCase())?.priceUsd ??
      prices.find((p) => p.priceUsd != null && p.poolAddress !== v2.poolAddress)?.priceUsd;

    if (pancakeUsdEst == null || otherUsd == null) {
      return null;
    }

    const diff = percentDifference(pancakeUsdEst, otherUsd);
    if (diff < this.config.priceDiffAlertPercent) {
      return null;
    }

    if (pancakeUsdEst < otherUsd) {
      return {
        shouldSell: false,
        poolName: v2.poolName,
        amountWpkn: 0n,
        reason: "Other pool is more expensive — sell-only will not buy wPKN",
      };
    }

    if (v2.wpknReserve < this.config.minWpkenReservePerPool) {
      return {
        shouldSell: false,
        poolName: v2.poolName,
        amountWpkn: 0n,
        reason: "Pancake wPKN below 50 — need manual LP add (no buy bot)",
      };
    }

    const headroom = v2.wpknReserve - this.config.minWpkenReservePerPool;
    const amountWpkn = headroom < this.config.maxWpknSellPerTx ? headroom : this.config.maxWpknSellPerTx;
    if (amountWpkn <= 0n) return null;

    return {
      shouldSell: true,
      poolName: v2.poolName,
      amountWpkn,
      reason: `USD gap ~${diff.toFixed(0)}% — sell ${formatUnits(amountWpkn, 18)} wPKN on Pancake`,
    };
  }

  async execute(plan: SellRebalancePlan, reserves: PoolReserves): Promise<string | null> {
    if (!plan.shouldSell) return null;

    const today = new Date().toISOString().slice(0, 10);
    const daily = this.db.getDailyUsage(today);
    if (daily.wpkenRefilled + plan.amountWpkn > this.config.maxWpknSellPerDay) {
      throw new Error("Daily wPKN sell limit reached");
    }

    const feeBps =
      this.config.pools.find((p) => p.address === reserves.poolAddress)?.feeBps ??
      this.config.defaultPoolFeeBps;

    const hash = await this.executor.sellWpknForQuote({
      amountWpkn: plan.amountWpkn,
      reserveWpkn: reserves.wpknReserve,
      reserveQuote: reserves.quoteReserve,
      feeBps,
      quoteTokenAddress: reserves.quoteToken.address,
    });

    this.db.addDailyUsage(today, plan.amountWpkn, 0n);
    this.db.recordTransaction(
      "sell_wpkn",
      "confirmed",
      { pool: plan.poolName, amount: plan.amountWpkn.toString(), reason: plan.reason },
      hash
    );

    logger.info({ hash, amount: formatUnits(plan.amountWpkn, 18) }, "Sold wPKN");
    return hash;
  }
}
