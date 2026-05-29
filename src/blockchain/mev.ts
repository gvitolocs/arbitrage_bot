/**
 * BNB Chain free MEV protection: route *transactions* through private builder RPCs
 * (not the public mempool). See:
 * https://docs.bnbchain.org/bnb-smart-chain/validator/mev/user-guide/
 * https://docs.pancakeswap.finance/trading-tools/pancakeswap-mev-guard
 */

/** Official free private RPCs (sandwich / frontrun mitigation). */
export const BSC_FREE_MEV_TX_RPCS = [
  "https://bscrpc.pancakeswap.finance",
  "https://rpc-bsc.48.club",
  "https://bsc.merkle.io",
] as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random delay so sells are not broadcast on a fixed cadence (minor bot fingerprint reduction). */
export async function applyTxJitter(maxMs: number): Promise<void> {
  if (maxMs <= 0) return;
  const delay = Math.floor(Math.random() * maxMs);
  if (delay > 0) await sleep(delay);
}

export function maskRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "invalid-url";
  }
}
