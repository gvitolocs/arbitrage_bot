import { formatUnits, parseUnits } from "ethers";
import type { JsonRpcProvider } from "ethers";
import type { BotConfig } from "../config.js";

export interface GasSnapshot {
  gasPriceWei: bigint;
  gasPriceGwei: number;
  withinLimit: boolean;
}

export async function fetchGasSnapshot(
  provider: JsonRpcProvider,
  config: BotConfig
): Promise<GasSnapshot> {
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const gasPriceGwei = Number(formatUnits(gasPriceWei, "gwei"));
  return {
    gasPriceWei,
    gasPriceGwei,
    withinLimit: gasPriceGwei <= config.maxGasPriceGwei,
  };
}

export function estimateGasCostWei(gasUnits: bigint, gasPriceWei: bigint): bigint {
  return gasUnits * gasPriceWei;
}

export function maxGasPriceWei(config: BotConfig): bigint {
  return parseUnits(String(config.maxGasPriceGwei), "gwei");
}
