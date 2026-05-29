/**
 * Pure Uniswap V2 AMM math (BigInt). Fee in basis points (e.g. 25 = 0.25%).
 */

export const BPS_DENOMINATOR = 10_000n;

export function applyFee(amountIn: bigint, feeBps: number): bigint {
  const fee = BigInt(feeBps);
  return (amountIn * (BPS_DENOMINATOR - fee)) / BPS_DENOMINATOR;
}

/** amountOut given amountIn */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number
): bigint {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const amountInWithFee = applyFee(amountIn, feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn + amountInWithFee;
  return numerator / denominator;
}

/** amountIn required for amountOut */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number
): bigint {
  if (amountOut <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (amountOut >= reserveOut) return 0n;

  const fee = BigInt(feeBps);
  const numerator = reserveIn * amountOut * BPS_DENOMINATOR;
  const denominator = (reserveOut - amountOut) * (BPS_DENOMINATOR - fee);
  return numerator / denominator + 1n;
}

/** Human price: quote tokens per 1 wPKN (scaled by decimals). */
export function calculatePrice(
  reserveToken: bigint,
  reserveQuote: bigint,
  decimalsToken: number,
  decimalsQuote: number
): number {
  if (reserveToken === 0n) return 0;
  const scaleToken = 10n ** BigInt(decimalsToken);
  const scaleQuote = 10n ** BigInt(decimalsQuote);
  const num = reserveQuote * scaleToken;
  const den = reserveToken * scaleQuote;
  return Number(num) / Number(den);
}

export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

export interface TwoPoolArbitrageInput {
  reserveWpknA: bigint;
  reserveQuoteA: bigint;
  reserveWpknB: bigint;
  reserveQuoteB: bigint;
  feeBpsA: number;
  feeBpsB: number;
  amountInWpkn: bigint;
  decimalsWpkn: number;
  decimalsQuote: number;
  gasCostQuote: bigint;
}

export interface TwoPoolArbitrageResult {
  profitable: boolean;
  amountInWpkn: bigint;
  quoteOutFromPoolA: bigint;
  quoteOutFromPoolB: bigint;
  profitQuote: bigint;
  netProfitQuote: bigint;
  direction: "buy_A_sell_B" | "buy_B_sell_A" | "none";
}

/**
 * Simulate: sell wPKN in the dearer pool, buy wPKN back in the cheaper pool.
 * sellPool = higher quote-per-wPKN; buyPool = lower quote-per-wPKN.
 */
export function simulateTwoPoolArbitrage(
  input: TwoPoolArbitrageInput
): TwoPoolArbitrageResult {
  const { amountInWpkn: amountIn } = input;
  if (amountIn <= 0n) {
    return emptyArb(amountIn);
  }

  const tryDirection = (
    sellWpknReserve: bigint,
    sellQuoteReserve: bigint,
    buyWpknReserve: bigint,
    buyQuoteReserve: bigint,
    feeSell: number,
    feeBuy: number,
    direction: "buy_A_sell_B" | "buy_B_sell_A"
  ): TwoPoolArbitrageResult => {
    const quoteFromSell = getAmountOut(
      amountIn,
      sellWpknReserve,
      sellQuoteReserve,
      feeSell
    );
    if (quoteFromSell <= 0n) return emptyArb(amountIn, direction);

    const wpknBack = getAmountOut(
      quoteFromSell,
      buyQuoteReserve,
      buyWpknReserve,
      feeBuy
    );
    const profitWpkn = wpknBack > amountIn ? wpknBack - amountIn : 0n;
    const profitQuote =
      profitWpkn > 0n
        ? getAmountOut(profitWpkn, sellWpknReserve, sellQuoteReserve, feeSell)
        : 0n;
    const netProfitQuote =
      profitQuote > input.gasCostQuote ? profitQuote - input.gasCostQuote : 0n;

    return {
      profitable: netProfitQuote > 0n,
      amountInWpkn: amountIn,
      quoteOutFromPoolA: direction === "buy_A_sell_B" ? quoteFromSell : 0n,
      quoteOutFromPoolB: direction === "buy_B_sell_A" ? quoteFromSell : 0n,
      profitQuote,
      netProfitQuote,
      direction,
    };
  };

  const priceA = calculatePrice(
    input.reserveWpknA,
    input.reserveQuoteA,
    input.decimalsWpkn,
    input.decimalsQuote
  );
  const priceB = calculatePrice(
    input.reserveWpknB,
    input.reserveQuoteB,
    input.decimalsWpkn,
    input.decimalsQuote
  );

  if (priceA >= priceB) {
    return tryDirection(
      input.reserveWpknA,
      input.reserveQuoteA,
      input.reserveWpknB,
      input.reserveQuoteB,
      input.feeBpsA,
      input.feeBpsB,
      "buy_B_sell_A"
    );
  }
  return tryDirection(
    input.reserveWpknB,
    input.reserveQuoteB,
    input.reserveWpknA,
    input.reserveQuoteA,
    input.feeBpsB,
    input.feeBpsA,
    "buy_A_sell_B"
  );
}

function emptyArb(
  amountIn: bigint,
  direction: TwoPoolArbitrageResult["direction"] = "none"
): TwoPoolArbitrageResult {
  return {
    profitable: false,
    amountInWpkn: amountIn,
    quoteOutFromPoolA: 0n,
    quoteOutFromPoolB: 0n,
    profitQuote: 0n,
    netProfitQuote: 0n,
    direction,
  };
}

/** wPKN and quote amounts to reach target wPKN reserve at current ratio. */
export function calculateLiquidityAmounts(
  currentWpkn: bigint,
  currentQuote: bigint,
  targetWpkn: bigint
): { wpkenToAdd: bigint; quoteToAdd: bigint } {
  if (targetWpkn <= currentWpkn) {
    return { wpkenToAdd: 0n, quoteToAdd: 0n };
  }
  const wpkenToAdd = targetWpkn - currentWpkn;
  const quoteToAdd = (wpkenToAdd * currentQuote) / currentWpkn;
  return { wpkenToAdd, quoteToAdd };
}

export function applySlippageMin(amount: bigint, slippageBps: number): bigint {
  const slip = BigInt(slippageBps);
  return (amount * (BPS_DENOMINATOR - slip)) / BPS_DENOMINATOR;
}

export function percentDifference(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const mid = (a + b) / 2;
  if (mid === 0) return 100;
  return (Math.abs(a - b) / mid) * 100;
}
