import { Contract, type Provider } from "ethers";
import { createRequire } from "node:module";
import type { BotConfig } from "../config.js";
import { getWpknBnbV4PoolKey } from "../dex/uniswapV4Pool.js";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);
const { Ether, Token } = require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const { Pool } = require("@uniswap/v4-sdk") as typeof import("@uniswap/v4-sdk");

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128 liquidity)",
] as const;

export interface V4OnChainSnapshot {
  poolId: string;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  poolExists: boolean;
}

export function getV4PoolId(config: BotConfig): string {
  const wpkn = new Token(config.chainId, config.wpkenAddress, 18, "wPKN", "wPKN");
  const native = Ether.onChain(config.chainId);
  const key = getWpknBnbV4PoolKey(config.wpkenAddress);
  return Pool.getPoolId(native, wpkn, key.fee, key.tickSpacing, key.hooks);
}

export async function readV4OnChain(
  provider: Provider,
  config: BotConfig
): Promise<V4OnChainSnapshot | null> {
  const stateView = config.uniswapStateView;
  if (!stateView) return null;

  const poolId = getV4PoolId(config);
  const c = new Contract(stateView, STATE_VIEW_ABI, provider);

  try {
    const [sqrtPriceX96, tick] = await c.getSlot0(poolId);
    const liquidity = (await c.getLiquidity(poolId)) as bigint;
    return {
      poolId,
      sqrtPriceX96: BigInt(sqrtPriceX96.toString()),
      tick: Number(tick),
      liquidity: BigInt(liquidity.toString()),
      poolExists: true,
    };
  } catch (err) {
    logger.warn({ err }, "Uniswap v4 StateView read failed");
    return { poolId, sqrtPriceX96: 0n, tick: 0, liquidity: 0n, poolExists: false };
  }
}

/** Economic wPKN in pool from USD reserves (best for thin CL pools). */
export function estimateWpknReserveFromUsd(reserveUsd: number, priceUsd: number): bigint {
  if (priceUsd <= 0 || reserveUsd <= 0) return 0n;
  const human = reserveUsd / priceUsd;
  return BigInt(Math.floor(human * 1e18));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function poolFromSnapshot(config: BotConfig, snapshot: V4OnChainSnapshot): any {
  const wpkn = new Token(config.chainId, config.wpkenAddress, 18, "wPKN", "wPKN");
  const native = Ether.onChain(config.chainId);
  const key = getWpknBnbV4PoolKey(config.wpkenAddress);
  return new Pool(
    native,
    wpkn,
    key.fee,
    key.tickSpacing,
    key.hooks,
    snapshot.sqrtPriceX96.toString(),
    snapshot.liquidity.toString(),
    snapshot.tick
  );
}

/** wPKN USD from v4 slot0 spot (token0 = BNB per 1 wPKN) × BNB/USD. */
export function wpknUsdFromSlot0(
  config: BotConfig,
  snapshot: V4OnChainSnapshot,
  bnbUsd: number
): number | null {
  if (!snapshot.poolExists || snapshot.sqrtPriceX96 === 0n || bnbUsd <= 0) return null;
  const pool = poolFromSnapshot(config, snapshot);
  const bnbPerWpkn = Number(pool.token0Price.toSignificant(18));
  return bnbPerWpkn * bnbUsd;
}

/** Spot wPKN out for a BNB→wPKN swap at current v4 tick (for amountOutMin / quotes). */
export function expectedWpknOutFromBnb(
  config: BotConfig,
  snapshot: V4OnChainSnapshot,
  amountBnb: bigint
): bigint | null {
  if (!snapshot.poolExists || amountBnb <= 0n) return null;
  const pool = poolFromSnapshot(config, snapshot);
  const wpknPerBnb = Number(pool.token1Price.toSignificant(18));
  const bnbHuman = Number(amountBnb) / 1e18;
  const wpknHuman = bnbHuman * wpknPerBnb;
  if (wpknHuman <= 0) return null;
  return BigInt(Math.floor(wpknHuman * 1e18));
}

/** Spot BNB out for a wPKN→BNB swap at current v4 tick. */
export function expectedNativeOutFromWpkn(
  config: BotConfig,
  snapshot: V4OnChainSnapshot,
  amountWpkn: bigint
): bigint | null {
  if (!snapshot.poolExists || amountWpkn <= 0n) return null;
  const pool = poolFromSnapshot(config, snapshot);
  const bnbPerWpkn = Number(pool.token0Price.toSignificant(18));
  const wpknHuman = Number(amountWpkn) / 1e18;
  const bnbHuman = wpknHuman * bnbPerWpkn;
  if (bnbHuman <= 0) return null;
  return BigInt(Math.floor(bnbHuman * 1e18));
}

/** Prefer on-chain spot when Gecko reserve is tiny or Gecko spot is a clear outlier. */
export function resolveV4PriceUsd(
  config: BotConfig,
  geckoPriceUsd: number,
  geckoReserveUsd: number,
  onChain: V4OnChainSnapshot | null,
  pancakePriceUsd: number,
  pancakeWbnbPerWpkn = 0
): { priceUsd: number; source: "gecko" | "onchain" } {
  const trustGecko =
    geckoReserveUsd >= config.minV4GeckoTrustReserveUsd &&
    pancakePriceUsd > 0 &&
    geckoPriceUsd > 0 &&
    percentOutlier(geckoPriceUsd, pancakePriceUsd) < 50;

  if (trustGecko) {
    return { priceUsd: geckoPriceUsd, source: "gecko" };
  }

  const bnbUsd =
    pancakePriceUsd > 0 && pancakeWbnbPerWpkn > 0
      ? pancakePriceUsd / pancakeWbnbPerWpkn
      : 630;
  const fromChain =
    onChain && pancakePriceUsd > 0
      ? wpknUsdFromSlot0(config, onChain, bnbUsd)
      : null;
  if (fromChain != null && fromChain > 0) {
    return { priceUsd: fromChain, source: "onchain" };
  }

  return { priceUsd: geckoPriceUsd, source: "gecko" };
}

function percentOutlier(a: number, b: number): number {
  const mid = (a + b) / 2;
  if (mid === 0) return 100;
  return (Math.abs(a - b) / mid) * 100;
}

/**
 * v4 USD for gap/rebalance only — ignores Gecko/on-chain outliers vs Pancake so we do not
 * fire 200% fake arbs or dust sells when the index price does not match executable depth.
 */
export function executableV4UsdForGap(
  config: BotConfig,
  geckoPriceUsd: number,
  resolvedPriceUsd: number,
  onChain: V4OnChainSnapshot | null,
  pancakePriceUsd: number,
  pancakeWbnbPerWpkn = 0
): number {
  if (pancakePriceUsd <= 0) return resolvedPriceUsd;

  const bnbUsd =
    pancakeWbnbPerWpkn > 0 ? pancakePriceUsd / pancakeWbnbPerWpkn : config.bnbUsdFallback ?? 630;
  const onChainUsd =
    onChain != null ? wpknUsdFromSlot0(config, onChain, bnbUsd) : null;

  if (onChainUsd != null && onChainUsd > 0 && percentOutlier(onChainUsd, pancakePriceUsd) < 50) {
    return onChainUsd;
  }
  if (geckoPriceUsd > 0 && percentOutlier(geckoPriceUsd, pancakePriceUsd) > 50) {
    return pancakePriceUsd;
  }
  if (resolvedPriceUsd > 0 && percentOutlier(resolvedPriceUsd, pancakePriceUsd) < 50) {
    return resolvedPriceUsd;
  }
  return pancakePriceUsd;
}

/** @deprecated use executableV4UsdForGap */
export function v4UsdForAlignment(
  geckoPriceUsd: number,
  resolvedPriceUsd: number,
  pancakePriceUsd: number
): number {
  if (geckoPriceUsd > pancakePriceUsd) {
    return Math.max(geckoPriceUsd, resolvedPriceUsd);
  }
  return resolvedPriceUsd;
}
