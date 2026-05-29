/** Shared domain types — single source of truth for cross-module contracts. */

export type PoolKind = "v2" | "gecko";

export interface PoolConfig {
  address: string;
  name: string;
  feeBps: number;
  kind: PoolKind;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolReserves {
  poolAddress: string;
  poolName: string;
  token0: TokenInfo;
  token1: TokenInfo;
  reserve0: bigint;
  reserve1: bigint;
  wpknReserve: bigint;
  quoteReserve: bigint;
  quoteToken: TokenInfo;
  blockNumber: number;
  timestamp: number;
}

export interface PoolPrice {
  poolAddress: string;
  poolName: string;
  /** Quote token per 1 wPKN (human-readable float for display only). */
  priceQuotePerWpkn: number;
  /** USD per wPKN from GeckoTerminal when pool.kind=gecko. */
  priceUsd?: number;
  /** wPKN per 1 quote (human-readable). */
  priceWpknPerQuote: number;
  wpkenReserveHuman: string;
  quoteReserveHuman: string;
  stale: boolean;
  suspiciousChange: boolean;
}

export interface ArbitrageSimulationResult {
  profitable: boolean;
  direction: string;
  amountInWpkn: bigint;
  estimatedProfitQuote: bigint;
  estimatedProfitQuoteHuman: string;
  gasEstimate: bigint;
  gasCostQuote: bigint;
  netProfitQuote: bigint;
  buyPool: string;
  sellPool: string;
  reason: string;
}

export interface LiquidityRefillPlan {
  poolAddress: string;
  poolName: string;
  currentWpknReserve: bigint;
  targetWpknReserve: bigint;
  wpkenToAdd: bigint;
  quoteToAdd: bigint;
  estimatedGas: bigint;
  canExecute: boolean;
  blockReason?: string;
}

export type AlertKind =
  | "low_reserve"
  | "price_divergence"
  | "arbitrage_opportunity"
  | "liquidity_refill_suggestion"
  | "rpc_failure"
  | "tx_failed"
  | "gas_too_high"
  | "wallet_low_balance"
  | "tx_success"
  | "startup"
  | "stale_pool";

export interface AlertPayload {
  kind: AlertKind;
  title: string;
  message: string;
  poolName?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface TxSafetyContext {
  dryRun: boolean;
  enableTrading: boolean;
  enableAutoLiquidity: boolean;
  maxGasPriceGwei: number;
  maxSlippageBps: number;
}

export interface DailyUsage {
  date: string;
  wpkenRefilled: bigint;
  wbnbSpent: bigint;
}

/** Read-only pool reader — implemented by blockchain/contracts. */
export interface IPoolReader {
  readPoolReserves(pool: PoolConfig): Promise<PoolReserves>;
}

/** Transaction execution — stub until milestone 2; must pass safety gates. */
export interface ITransactionExecutor {
  executeSwap(params: unknown): Promise<string>;
  executeAddLiquidity(params: unknown): Promise<string>;
}
