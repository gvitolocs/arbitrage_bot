import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdkCore = require("@uniswap/sdk-core") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const v4sdk = require("@uniswap/v4-sdk") as any;

const { Token, Ether } = sdkCore;
const { Pool } = v4sdk;

export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

/** Known wPKN/BNB 1% v4 pool on BSC (Gecko pool id). */
export const WPKN_BNB_V4_POOL_ID =
  "0xce826fc29e6c3d5ffbf30ab4ed68bcd6de43e237ad6485e3f0d76b4075c810bf";

const HOOKS_ZERO = "0x0000000000000000000000000000000000000000";

export interface V4PoolParams {
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export const DEFAULT_WPKN_BNB_V4: V4PoolParams = {
  fee: 10_000,
  tickSpacing: 200,
  hooks: HOOKS_ZERO,
};

export function getWpknBnbV4PoolKey(
  wpkenAddress: string,
  params: V4PoolParams = DEFAULT_WPKN_BNB_V4
): PoolKey {
  const wpkn = new Token(56, wpkenAddress, 18, "wPKN", "wPKN");
  const native = Ether.onChain(56);
  return Pool.getPoolKey(native, wpkn, params.fee, params.tickSpacing, params.hooks);
}
