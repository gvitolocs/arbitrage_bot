import type { BotConfig } from "../config.js";
import { PoolReader } from "../blockchain/contracts.js";
import { fetchGasSnapshot } from "../blockchain/gas.js";
import { ProviderManager } from "../blockchain/provider.js";
import { calculateLiquidityAmounts, formatUnits } from "../dex/uniswapV2Math.js";
import type { BotDatabase } from "../db/index.js";
import type { LiquidityRefillPlan, PoolReserves } from "../types.js";
import type { GeckoPoolSnapshot } from "./geckoTerminal.js";
import { logger } from "../logger.js";

const ESTIMATED_ADD_LIQ_GAS = 350_000n;

export class LiquidityGuardian {
  constructor(
    private readonly config: BotConfig,
    private readonly poolReader: PoolReader,
    private readonly providerManager: ProviderManager,
    private readonly db: BotDatabase
  ) {}

  async planRefills(
    reserves: PoolReserves[],
    geckoPools: GeckoPoolSnapshot[] = []
  ): Promise<LiquidityRefillPlan[]> {
    const plans: LiquidityRefillPlan[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.db.getDailyUsage(today);
    const balances = await this.poolReader.getWalletBalances();

    const gas = await this.providerManager.withFallback((p) =>
      fetchGasSnapshot(p, this.config)
    );

    for (const r of reserves) {
      if (r.wpknReserve >= this.config.minWpkenReservePerPool) {
        continue;
      }

      const target = this.config.minWpkenReservePerPool;
      const { wpkenToAdd, quoteToAdd } = calculateLiquidityAmounts(
        r.wpknReserve,
        r.quoteReserve,
        target
      );

      const blockReasons: string[] = [];
      if (wpkenToAdd > this.config.maxWpkenRefillPerTx) {
        blockReasons.push("exceeds MAX_WPKN_REFILL_PER_TX");
      }
      if (quoteToAdd > this.config.maxWbnbSpendPerTx) {
        blockReasons.push("exceeds MAX_WBNB_SPEND_PER_TX");
      }
      if (daily.wpkenRefilled + wpkenToAdd > this.config.maxWpkenRefillPerDay) {
        blockReasons.push("exceeds daily wPKN limit");
      }
      if (daily.wbnbSpent + quoteToAdd > this.config.maxWbnbSpendPerDay) {
        blockReasons.push("exceeds daily WBNB limit");
      }
      if (!gas.withinLimit) {
        blockReasons.push(`gas ${gas.gasPriceGwei.toFixed(2)} gwei too high`);
      }
      if (balances.wpken < wpkenToAdd) {
        blockReasons.push("insufficient wPKN wallet balance");
      }
      if (balances.wbnb < quoteToAdd) {
        blockReasons.push("insufficient WBNB wallet balance");
      }
      if (this.config.dryRun || !this.config.enableAutoLiquidity) {
        blockReasons.push("auto-liquidity disabled (dry-run or config)");
      }
      if (this.config.requireManualConfirmation) {
        blockReasons.push("REQUIRE_MANUAL_CONFIRMATION=true");
      }

      const plan: LiquidityRefillPlan = {
        poolAddress: r.poolAddress,
        poolName: r.poolName,
        currentWpknReserve: r.wpknReserve,
        targetWpknReserve: target,
        wpkenToAdd,
        quoteToAdd,
        estimatedGas: ESTIMATED_ADD_LIQ_GAS,
        canExecute: blockReasons.length === 0,
        blockReason: blockReasons.length ? blockReasons.join("; ") : undefined,
      };

      plans.push(plan);
      logger.warn(
        {
          pool: r.poolName,
          wpkn: formatUnits(r.wpknReserve, 18),
          wpkenToAdd: formatUnits(wpkenToAdd, 18),
          quoteToAdd: formatUnits(quoteToAdd, r.quoteToken.decimals),
          canExecute: plan.canExecute,
        },
        "Liquidity refill suggestion"
      );
    }

    for (const g of geckoPools) {
      const w = g.wpkenReserveEstimate;
      if (!w || w >= this.config.minWpkenReservePerPool) continue;

      const wpkenToAdd = this.config.minWpkenReservePerPool - w;
      plans.push({
        poolAddress: g.poolAddress,
        poolName: g.name,
        currentWpknReserve: w,
        targetWpknReserve: this.config.minWpkenReservePerPool,
        wpkenToAdd,
        quoteToAdd: 0n,
        estimatedGas: ESTIMATED_ADD_LIQ_GAS,
        canExecute: false,
        blockReason:
          "Uniswap v4 below min wPKN — add liquidity manually (auto-liquidity not supported on v4)",
      });
      logger.warn(
        { pool: g.name, wpkn: formatUnits(w, 18), wpkenToAdd: formatUnits(wpkenToAdd, 18) },
        "Uniswap v4 low wPKN reserve"
      );
    }

    return plans;
  }
}
