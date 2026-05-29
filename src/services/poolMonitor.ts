import type { BotConfig } from "../config.js";
import { PoolReader } from "../blockchain/contracts.js";
import type { ProviderManager } from "../blockchain/provider.js";
import {
  readV4OnChain,
  resolveV4PriceUsd,
  executableV4UsdForGap,
  type V4OnChainSnapshot,
} from "../blockchain/uniswapV4Reader.js";
import { calculatePrice, formatUnits, percentDifference } from "../dex/uniswapV2Math.js";
import { shouldRebalanceForGap } from "../dex/priceGap.js";
import type { BotDatabase } from "../db/index.js";
import type { PoolConfig, PoolPrice, PoolReserves } from "../types.js";
import { logger } from "../logger.js";
import { fetchPoolByAddress, type GeckoPoolSnapshot } from "./geckoTerminal.js";

export interface MonitorCycleResult {
  reserves: PoolReserves[];
  geckoPools: GeckoPoolSnapshot[];
  prices: PoolPrice[];
  /** Gap used for rebalance decisions. */
  priceDiffPercent: number;
  rawPriceDiffPercent: number;
  /** True when gap above target — bot should sell on expensive venue. */
  priceGapActionable: boolean;
  alerts: string[];
}

export class PoolMonitor {
  private lastReserveByPool = new Map<string, bigint>();

  constructor(
    private readonly config: BotConfig,
    private readonly poolReader: PoolReader,
    private readonly providerManager: ProviderManager,
    private readonly db: BotDatabase
  ) {}

  async runCycle(): Promise<MonitorCycleResult> {
    const reserves: PoolReserves[] = [];
    const geckoPools: GeckoPoolSnapshot[] = [];
    const prices: PoolPrice[] = [];
    const alerts: string[] = [];
    let v4OnChain: V4OnChainSnapshot | null = null;

    for (const pool of this.config.pools) {
      if (pool.kind === "gecko" || pool.kind === "v4") {
        try {
          const g = await fetchPoolByAddress(this.config.geckoNetwork, pool.address);
          geckoPools.push(g);

          if (
            (pool.kind === "v4" || pool.kind === "gecko") &&
            this.config.uniswapStateView
          ) {
            v4OnChain = await this.providerManager.withReadFallback((p) =>
              readV4OnChain(p, this.config)
            );
          }

          const wpkenReserve = g.wpkenReserveEstimate ?? 0n;
          const wpkenDecimals = 18;
          if (wpkenReserve > 0n && wpkenReserve < this.config.minWpkenReservePerPool) {
            alerts.push(
              `${pool.name}: wPKN ~${formatUnits(wpkenReserve, wpkenDecimals)} < min ${formatUnits(this.config.minWpkenReservePerPool, wpkenDecimals)}`
            );
          }

          prices.push({
            poolAddress: pool.address,
            poolName: pool.name,
            priceQuotePerWpkn: g.priceNativePerWpkn,
            priceWpknPerQuote: g.priceNativePerWpkn > 0 ? 1 / g.priceNativePerWpkn : 0,
            priceUsd: g.priceUsd,
            wpkenReserveHuman: wpkenReserve
              ? formatUnits(wpkenReserve, wpkenDecimals)
              : "n/a (v4)",
            quoteReserveHuman: `Gecko TVL $${g.reserveUsd.toFixed(2)}`,
            stale: g.reserveUsd < 1,
            suspiciousChange: false,
            wpkenReserve,
          });

          if (g.reserveUsd < 1) {
            alerts.push(`${pool.name}: very low liquidity ($${g.reserveUsd})`);
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
          wpkenReserve: r.wpknReserve,
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

    const pancakePx = prices.find((p) => p.poolAddress === reserves[0]?.poolAddress);
    const pancakeUsd = pancakePx?.priceUsd;
    const v4Px = prices.find((p) => p.poolAddress !== reserves[0]?.poolAddress);
    const v4Gecko = geckoPools.find(
      (g) => v4Px && g.poolAddress.toLowerCase() === v4Px.poolAddress.toLowerCase()
    );

    if (v4Px && v4Gecko && pancakeUsd != null) {
      const resolved = resolveV4PriceUsd(
        this.config,
        v4Gecko.priceUsd,
        v4Gecko.reserveUsd,
        v4OnChain,
        pancakeUsd,
        pancakePx?.priceQuotePerWpkn ?? 0
      );
      const geckoGap =
        pancakeUsd > 0
          ? (Math.abs(v4Gecko.priceUsd - pancakeUsd) /
              ((v4Gecko.priceUsd + pancakeUsd) / 2)) *
            100
          : 0;
      const onChainGap =
        pancakeUsd > 0
          ? (Math.abs(resolved.priceUsd - pancakeUsd) /
              ((resolved.priceUsd + pancakeUsd) / 2)) *
            100
          : 0;

      if (geckoGap > this.config.targetPriceDiffPercent && onChainGap <= this.config.targetPriceDiffPercent) {
        alerts.push(
          `${v4Px.poolName}: Gecko spot $${v4Gecko.priceUsd.toFixed(4)} (${geckoGap.toFixed(0)}% vs Pancake) — executable on-chain ~$${resolved.priceUsd.toFixed(4)} (${onChainGap.toFixed(1)}%); chart won't move until v4 swaps fill`
        );
      } else if (
        resolved.source === "onchain" &&
        Math.abs(resolved.priceUsd - v4Gecko.priceUsd) > 0.0001
      ) {
        alerts.push(
          `${v4Px.poolName}: Gecko $${v4Gecko.priceUsd.toFixed(4)} unreliable — on-chain ~$${resolved.priceUsd.toFixed(4)}`
        );
      }
      v4Px.priceUsd = executableV4UsdForGap(
        this.config,
        v4Gecko.priceUsd,
        resolved.priceUsd,
        v4OnChain,
        pancakeUsd,
        pancakePx?.priceQuotePerWpkn ?? 0
      );
      (v4Px as PoolPrice & { geckoPriceUsd?: number }).geckoPriceUsd = v4Gecko.priceUsd;
      if (pancakePx && pancakeUsd > 0 && pancakePx.priceQuotePerWpkn > 0) {
        const bnbUsd = pancakeUsd / pancakePx.priceQuotePerWpkn;
        v4Px.priceQuotePerWpkn = bnbUsd > 0 ? v4Px.priceUsd! / bnbUsd : v4Px.priceQuotePerWpkn;
      }
    }

    let rawPriceDiffPercent = 0;
    const usdPrices = prices.filter((p) => p.priceUsd != null).map((p) => p.priceUsd!);
    if (usdPrices.length >= 2) {
      rawPriceDiffPercent = percentDifference(usdPrices[0]!, usdPrices[1]!);
    } else if (prices.length >= 2) {
      rawPriceDiffPercent = percentDifference(
        prices[0]!.priceQuotePerWpkn,
        prices[1]!.priceQuotePerWpkn
      );
    }

    const gapCheck = shouldRebalanceForGap(
      rawPriceDiffPercent,
      this.config.priceDiffAlertPercent,
      this.config.targetPriceDiffPercent
    );
    const priceGapActionable = gapCheck.rebalance;
    const priceDiffPercent = rawPriceDiffPercent;

    if (priceGapActionable && prices.length >= 2) {
      alerts.push(
        `Align prices: gap ${rawPriceDiffPercent.toFixed(1)}% (target ≤${this.config.targetPriceDiffPercent}%) — ${prices[0]!.poolName} vs ${prices[1]!.poolName}`
      );
    }

    return {
      reserves,
      geckoPools,
      prices,
      priceDiffPercent,
      rawPriceDiffPercent,
      priceGapActionable,
      alerts,
    };
  }
}

export function getPoolFee(config: BotConfig, pool: PoolConfig): number {
  return pool.feeBps ?? config.defaultPoolFeeBps;
}
