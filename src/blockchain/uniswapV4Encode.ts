/**
 * Uniswap SDK is CJS-friendly via createRequire (Node ESM cannot import sdk-core directly).
 */
import { createRequire } from "node:module";
import type { PoolKey } from "@uniswap/v4-sdk";

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdkCore = require("@uniswap/sdk-core") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const urSdk = require("@uniswap/universal-router-sdk") as any;

const { Token, Ether, Percent, TradeType, CurrencyAmount } = sdkCore;
const { SwapRouter, UniversalRouterVersion } = urSdk;

export function encodeNativeToWpknV4Swap(params: {
  chainId: number;
  wpkenAddress: string;
  recipient: string;
  amountBnb: bigint;
  expectedWpknOut: bigint;
  amountOutMin: bigint;
  maxSlippageBps: number;
  poolKey: PoolKey;
}): { calldata: string; value: string } {
  const wpkn = new Token(params.chainId, params.wpkenAddress, 18, "wPKN", "wPKN");
  const native = Ether.onChain(params.chainId);
  const amountIn = CurrencyAmount.fromRawAmount(native, params.amountBnb.toString());

  return SwapRouter.encodeSwaps(
    {
      tradeType: TradeType.EXACT_INPUT,
      routing: {
        inputToken: native,
        outputToken: wpkn,
        amount: amountIn,
        quote: CurrencyAmount.fromRawAmount(wpkn, params.expectedWpknOut.toString()),
      },
      slippageTolerance: new Percent(params.maxSlippageBps, 10_000),
      recipient: params.recipient,
      chainId: params.chainId,
      urVersion: UniversalRouterVersion.V2_1_1,
    },
    [
      {
        type: "V4_SWAP",
        v4Actions: [
          {
            action: "SWAP_EXACT_IN_SINGLE",
            poolKey: params.poolKey,
            zeroForOne: true,
            amountIn: params.amountBnb.toString(),
            amountOutMinimum: params.amountOutMin.toString(),
            hookData: "0x",
          },
          {
            action: "SETTLE_ALL",
            currency: params.poolKey.currency0,
            maxAmount: params.amountBnb.toString(),
          },
          {
            action: "TAKE_ALL",
            currency: params.poolKey.currency1,
            minAmount: params.amountOutMin.toString(),
          },
        ],
      },
    ]
  );
}

export function encodeWpknToNativeV4Swap(params: {
  chainId: number;
  wpkenAddress: string;
  recipient: string;
  amountWpkn: bigint;
  expectedNativeOut: bigint;
  amountOutMin: bigint;
  maxSlippageBps: number;
  poolKey: PoolKey;
}): { calldata: string; value: string } {
  const wpkn = new Token(params.chainId, params.wpkenAddress, 18, "wPKN", "wPKN");
  const native = Ether.onChain(params.chainId);
  const amountIn = CurrencyAmount.fromRawAmount(wpkn, params.amountWpkn.toString());

  return SwapRouter.encodeSwaps(
    {
      tradeType: TradeType.EXACT_INPUT,
      routing: {
        inputToken: wpkn,
        outputToken: native,
        amount: amountIn,
        quote: CurrencyAmount.fromRawAmount(native, params.expectedNativeOut.toString()),
      },
      slippageTolerance: new Percent(params.maxSlippageBps, 10_000),
      recipient: params.recipient,
      chainId: params.chainId,
      urVersion: UniversalRouterVersion.V2_1_1,
    },
    [
      {
        type: "V4_SWAP",
        v4Actions: [
          {
            action: "SWAP_EXACT_IN_SINGLE",
            poolKey: params.poolKey,
            zeroForOne: false,
            amountIn: params.amountWpkn.toString(),
            amountOutMinimum: params.amountOutMin.toString(),
            hookData: "0x",
          },
          {
            action: "SETTLE_ALL",
            currency: params.poolKey.currency1,
            maxAmount: params.amountWpkn.toString(),
          },
          {
            action: "TAKE_ALL",
            currency: params.poolKey.currency0,
            minAmount: params.amountOutMin.toString(),
          },
        ],
      },
    ]
  );
}
