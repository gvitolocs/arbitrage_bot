import { parseUnits } from "ethers";
import type { BotConfig } from "../config.js";
import { fetchGasSnapshot, estimateGasCostWei } from "../blockchain/gas.js";
import { ProviderManager } from "../blockchain/provider.js";
import {
  formatUnits as formatUnitsMath,
  simulateTwoPoolArbitrage,
} from "../dex/uniswapV2Math.js";
import type { BotDatabase } from "../db/index.js";
import type { ArbitrageSimulationResult, PoolReserves } from "../types.js";
import { getPoolFee } from "./poolMonitor.js";
import { logger } from "../logger.js";

const DEFAULT_ARB_WPKN_IN = parseUnits("1", 18);
const ESTIMATED_SWAP_GAS = 180_000n;

export class ArbitrageSimulator {
  constructor(
    private readonly config: BotConfig,
    private readonly providerManager: ProviderManager,
    private readonly db: BotDatabase
  ) {}

  async simulate(
    reserves: PoolReserves[]
  ): Promise<ArbitrageSimulationResult | null> {
    if (reserves.length < 2) return null;

    const [a, b] = reserves;
    const feeA = getPoolFee(this.config, this.config.pools.find((p) => p.address === a.poolAddress)!);
    const feeB = getPoolFee(this.config, this.config.pools.find((p) => p.address === b.poolAddress)!);

    const gas = await this.providerManager.withFallback((p) =>
      fetchGasSnapshot(p, this.config)
    );
    const gasCostQuote = estimateGasCostWei(
      ESTIMATED_SWAP_GAS * 2n,
      gas.gasPriceWei
    );

    const sim = simulateTwoPoolArbitrage({
      reserveWpknA: a.wpknReserve,
      reserveQuoteA: a.quoteReserve,
      reserveWpknB: b.wpknReserve,
      reserveQuoteB: b.quoteReserve,
      feeBpsA: feeA,
      feeBpsB: feeB,
      amountInWpkn: DEFAULT_ARB_WPKN_IN,
      decimalsWpkn: 18,
      decimalsQuote: a.quoteToken.decimals,
      gasCostQuote,
    });

    const minProfit = parseUnits(String(this.config.arbitrageMinProfitBnb), 18);
    const profitable =
      sim.profitable && sim.netProfitQuote >= minProfit && gas.withinLimit;

    const result: ArbitrageSimulationResult = {
      profitable,
      direction: sim.direction,
      amountInWpkn: sim.amountInWpkn,
      estimatedProfitQuote: sim.profitQuote,
      estimatedProfitQuoteHuman: formatUnitsMath(sim.profitQuote, a.quoteToken.decimals),
      gasEstimate: ESTIMATED_SWAP_GAS * 2n,
      gasCostQuote,
      netProfitQuote: sim.netProfitQuote,
      buyPool: sim.direction === "buy_A_sell_B" ? a.poolName : b.poolName,
      sellPool: sim.direction === "buy_A_sell_B" ? b.poolName : a.poolName,
      reason: profitable
        ? "Simulated arb exceeds min profit after gas"
        : gas.withinLimit
          ? "Below min profit or not profitable"
          : `Gas ${gas.gasPriceGwei.toFixed(2)} gwei > max ${this.config.maxGasPriceGwei}`,
    };

    this.db.saveOpportunity("arbitrage", result);

    if (profitable) {
      logger.info({ result }, "Arbitrage opportunity (simulation only)");
    } else {
      logger.debug({ result }, "No profitable arbitrage");
    }

    return result;
  }
}
