import type { BotConfig } from "../config.js";
import type { PoolReader } from "../blockchain/contracts.js";
import type { ProviderManager } from "../blockchain/provider.js";
import { SwapExecutor } from "../blockchain/executor.js";
import { UniswapV4Executor } from "../blockchain/uniswapV4Executor.js";
import {
  executableV4UsdForGap,
  expectedNativeOutFromWpkn,
  readV4OnChain,
  resolveV4PriceUsd,
} from "../blockchain/uniswapV4Reader.js";
import { getWpknBnbV4PoolKey } from "../dex/uniswapV4Pool.js";
import { getPoolFee } from "./poolMonitor.js";
import { formatUnits, percentDifference } from "../dex/uniswapV2Math.js";
import { shouldRebalanceForGap } from "../dex/priceGap.js";
import type { BotDatabase } from "../db/index.js";
import type { GeckoPoolSnapshot } from "./geckoTerminal.js";
import type { PoolConfig, PoolPrice, PoolReserves } from "../types.js";
import { logger } from "../logger.js";

export type SellVenue = "pancake_v2" | "uniswap_v4";

export interface SellRebalancePlan {
  shouldSell: boolean;
  venue: SellVenue;
  poolName: string;
  amountWpkn: bigint;
  reason: string;
  expectedNativeOut?: bigint;
}

/** Sell wPKN on whichever pool is expensive — Pancake V2 or Uniswap v4. Never buys wPKN. */
export class SellRebalancer {
  private readonly v4Executor: UniswapV4Executor;

  constructor(
    private readonly config: BotConfig,
    private readonly poolReader: PoolReader,
    private readonly providerManager: ProviderManager,
    private readonly pancakeExecutor: SwapExecutor,
    private readonly db: BotDatabase
  ) {
    this.v4Executor = new UniswapV4Executor(config, providerManager);
  }

  private v4PoolConfig(): PoolConfig | undefined {
    return this.config.pools.find((p) => p.kind === "v4" || p.kind === "gecko");
  }

  private estimateNativeOut(amountWpkn: bigint, bnbPerWpkn: number): bigint {
    if (bnbPerWpkn <= 0) return 0n;
    const scaled = BigInt(Math.floor(bnbPerWpkn * 1e18));
    return (amountWpkn * scaled) / 10n ** 18n;
  }

  /** Smaller sells on thin v4 so txs can land while pushing price down toward Pancake. */
  private v4SellAmount(reserveUsd: number, priceUsd: number): bigint {
    const cap = this.config.maxWpknSellPerTx;
    if (reserveUsd >= this.config.minV4PoolReserveUsd) {
      return cap;
    }
    const thin = this.config.v4SellWpknThinPool;
    if (priceUsd > 0 && reserveUsd > 0) {
      const fromPool = BigInt(
        Math.floor(((reserveUsd * 0.12) / priceUsd) * 1e18)
      );
      if (fromPool > 0n && fromPool < cap) {
        return fromPool < thin ? fromPool : thin;
      }
    }
    return thin < cap ? thin : cap;
  }

  private bnbPerWpknFromUsd(wpkenUsd: number, pancakeUsd: number, pancakeWbnbPerWpkn: number): number {
    if (pancakeWbnbPerWpkn <= 0 || pancakeUsd <= 0) return 0;
    const bnbUsd = pancakeUsd / pancakeWbnbPerWpkn;
    return bnbUsd > 0 ? wpkenUsd / bnbUsd : 0;
  }

  async plan(
    v2Reserves: PoolReserves[],
    prices: PoolPrice[],
    geckoPools: GeckoPoolSnapshot[]
  ): Promise<SellRebalancePlan | null> {
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

    const v4Pool = this.v4PoolConfig();
    const v4Gecko = geckoPools.find(
      (g) =>
        v4Pool &&
        g.poolAddress.toLowerCase() === v4Pool.address.toLowerCase()
    );
    let otherUsd =
      v4Gecko?.priceUsd ??
      prices.find(
        (p) => p.priceUsd != null && p.poolAddress !== v2.poolAddress
      )?.priceUsd;

    let v4ResolvedUsd = otherUsd;
    let v4OnChain: Awaited<ReturnType<typeof readV4OnChain>> = null;
    if (v4Gecko && pancakeUsdEst != null) {
      v4OnChain = await this.providerManager.withReadFallback((p) =>
        readV4OnChain(p, this.config)
      );
      const pancakeQuote =
        v2Price?.priceQuotePerWpkn ?? prices.find((p) => p.poolAddress === v2.poolAddress)
          ?.priceQuotePerWpkn ??
        0;
      const resolved = resolveV4PriceUsd(
        this.config,
        v4Gecko.priceUsd,
        v4Gecko.reserveUsd,
        v4OnChain,
        pancakeUsdEst,
        pancakeQuote
      );
      v4ResolvedUsd = resolved.priceUsd;
      otherUsd = executableV4UsdForGap(
        this.config,
        v4Gecko.priceUsd,
        v4ResolvedUsd,
        v4OnChain,
        pancakeUsdEst,
        pancakeQuote
      );
    }

    if (pancakeUsdEst == null || otherUsd == null) {
      return null;
    }

    const diff = percentDifference(pancakeUsdEst, otherUsd);
    const gap = shouldRebalanceForGap(
      diff,
      this.config.priceDiffAlertPercent,
      this.config.targetPriceDiffPercent
    );
    if (!gap.rebalance) {
      return {
        shouldSell: false,
        venue: pancakeUsdEst > otherUsd ? "pancake_v2" : "uniswap_v4",
        poolName: v4Pool?.name ?? v2.poolName,
        amountWpkn: 0n,
        reason: gap.reason ?? `no rebalance`,
      };
    }

    const pancakeExpensive = pancakeUsdEst > otherUsd;

    if (pancakeExpensive) {
      if (v2.wpknReserve < this.config.minWpkenReservePerPool) {
        return {
          shouldSell: false,
          venue: "pancake_v2",
          poolName: v2.poolName,
          amountWpkn: 0n,
          reason: "Pancake wPKN below 50 — need manual LP add (no buy bot)",
        };
      }
      const headroom = v2.wpknReserve - this.config.minWpkenReservePerPool;
      const amountWpkn =
        headroom < this.config.maxWpknSellPerTx ? headroom : this.config.maxWpknSellPerTx;
      if (amountWpkn <= 0n) return null;

      return {
        shouldSell: true,
        venue: "pancake_v2",
        poolName: v2.poolName,
        amountWpkn,
        reason: `USD gap ~${diff.toFixed(0)}% — sell ${formatUnits(amountWpkn, 18)} wPKN on Pancake`,
      };
    }

    // Uniswap v4 is the expensive side — sell wallet wPKN there.
    if (!this.config.uniswapUniversalRouter) {
      return {
        shouldSell: false,
        venue: "uniswap_v4",
        poolName: v4Pool?.name ?? "wPKN/BNB",
        amountWpkn: 0n,
        reason:
          "Uniswap is more expensive but UNISWAP_UNIVERSAL_ROUTER is not set — cannot sell on v4",
      };
    }

    const reserveUsd = v4Gecko?.reserveUsd ?? 0;
    const pancakeQuote =
      v2Price?.priceQuotePerWpkn ??
      prices.find((p) => p.poolAddress === v2.poolAddress)?.priceQuotePerWpkn ??
      0;
    const execUsd = v4ResolvedUsd ?? otherUsd;
    const bnbPerWpkn = this.bnbPerWpknFromUsd(execUsd, pancakeUsdEst, pancakeQuote);
    const amountWpkn = this.v4SellAmount(reserveUsd, otherUsd);
    const minV4SellWei = this.config.v4SellWpknThinPool;
    if (amountWpkn < minV4SellWei) {
      return {
        shouldSell: false,
        venue: "uniswap_v4",
        poolName: v4Pool?.name ?? "wPKN/BNB",
        amountWpkn: 0n,
        reason: `Uniswap v4 clip ${formatUnits(amountWpkn, 18)} wPKN below minimum — Gecko gap not executable`,
      };
    }
    if (amountWpkn <= 0n) {
      return {
        shouldSell: false,
        venue: "uniswap_v4",
        poolName: v4Pool?.name ?? "wPKN/BNB",
        amountWpkn: 0n,
        reason: "Uniswap v4 sell amount rounds to zero",
      };
    }

    const fromSlot =
      v4OnChain != null
        ? expectedNativeOutFromWpkn(this.config, v4OnChain, amountWpkn)
        : null;
    const expectedNativeOut =
      fromSlot != null && fromSlot > 0n
        ? fromSlot
        : this.estimateNativeOut(amountWpkn, bnbPerWpkn);
    if (expectedNativeOut <= 0n) {
      return {
        shouldSell: false,
        venue: "uniswap_v4",
        poolName: v4Pool?.name ?? "wPKN/BNB",
        amountWpkn: 0n,
        reason: "Cannot estimate BNB output for Uniswap v4 sell",
      };
    }

    const thinNote =
      reserveUsd < this.config.minV4PoolReserveUsd
        ? ` (thin pool ~$${reserveUsd.toFixed(2)}, clip ${formatUnits(amountWpkn, 18)} wPKN)`
        : "";

    return {
      shouldSell: true,
      venue: "uniswap_v4",
      poolName: v4Pool?.name ?? "wPKN/BNB",
      amountWpkn,
      reason: `Align ≤${this.config.targetPriceDiffPercent}%: gap ${diff.toFixed(0)}% — sell ${formatUnits(amountWpkn, 18)} wPKN on Uniswap${thinNote}`,
      expectedNativeOut,
    };
  }

  async execute(
    plan: SellRebalancePlan,
    reserves: PoolReserves
  ): Promise<string | null> {
    if (!plan.shouldSell) return null;

    const today = new Date().toISOString().slice(0, 10);
    const daily = this.db.getDailyUsage(today);
    if (daily.wpkenRefilled + plan.amountWpkn > this.config.maxWpknSellPerDay) {
      throw new Error("Daily wPKN sell limit reached");
    }

    let hash: string;

    if (plan.venue === "uniswap_v4") {
      const poolKey = getWpknBnbV4PoolKey(this.config.wpkenAddress);
      if (
        this.v4PoolConfig()?.address &&
        !poolKey.currency1.toLowerCase().includes(this.config.wpkenAddress.slice(2).toLowerCase())
      ) {
        throw new Error("v4 pool key mismatch for wPKN");
      }

      hash = await this.v4Executor.sellWpknForNative({
        amountWpkn: plan.amountWpkn,
        poolKey,
        expectedNativeOut: plan.expectedNativeOut ?? 0n,
      });
    } else {
      const poolCfg = this.config.pools.find(
        (p) => p.address.toLowerCase() === reserves.poolAddress.toLowerCase()
      );
      if (!poolCfg || poolCfg.kind !== "v2") {
        throw new Error("Sell execution only supported on V2 pools");
      }

      const fresh = await this.poolReader.readPoolReserves(poolCfg);
      const feeBps = getPoolFee(this.config, poolCfg);

      hash = await this.pancakeExecutor.sellWpknForQuote({
        amountWpkn: plan.amountWpkn,
        reserveWpkn: fresh.wpknReserve,
        reserveQuote: fresh.quoteReserve,
        feeBps,
        quoteTokenAddress: fresh.quoteToken.address,
      });
    }

    this.db.addDailyUsage(today, plan.amountWpkn, 0n);
    this.db.recordTransaction(
      "sell_wpkn",
      "confirmed",
      {
        pool: plan.poolName,
        venue: plan.venue,
        amount: plan.amountWpkn.toString(),
        reason: plan.reason,
      },
      hash
    );

    logger.info({ hash, venue: plan.venue, amount: formatUnits(plan.amountWpkn, 18) }, "Sold wPKN");
    return hash;
  }
}
