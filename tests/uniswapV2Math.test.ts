import { describe, it, expect } from "vitest";
import {
  getAmountOut,
  getAmountIn,
  calculatePrice,
  simulateTwoPoolArbitrage,
  calculateLiquidityAmounts,
  applySlippageMin,
  percentDifference,
} from "../src/dex/uniswapV2Math.js";

describe("getAmountOut", () => {
  it("returns zero for zero input", () => {
    expect(getAmountOut(0n, 1000n, 1000n, 25)).toBe(0n);
  });

  it("matches constant product with fee", () => {
    const out = getAmountOut(100n, 1_000_000n, 1_000_000n, 25);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(100n);
  });
});

describe("getAmountIn", () => {
  it("is inverse of getAmountOut within rounding", () => {
    const amountOut = 50_000_000000000000n;
    const reserveIn = 1_000_000_000000000000000n;
    const reserveOut = 1_000_000_000000000000000n;
    const fee = 25;
    const amountIn = getAmountIn(amountOut, reserveIn, reserveOut, fee);
    const back = getAmountOut(amountIn, reserveIn, reserveOut, fee);
    expect(back).toBeGreaterThanOrEqual(amountOut - 1n);
  });
});

describe("calculatePrice", () => {
  it("computes quote per token", () => {
    const price = calculatePrice(1_000_000_000000000000n, 2_000_000_000000000000n, 18, 18);
    expect(price).toBeCloseTo(2, 5);
  });
});

describe("simulateTwoPoolArbitrage", () => {
  it("detects profit when pools diverge", () => {
    const result = simulateTwoPoolArbitrage({
      reserveWpknA: 1_000_000_000000000000n,
      reserveQuoteA: 1_000_000_000000000000n,
      reserveWpknB: 1_000_000_000000000000n,
      reserveQuoteB: 2_000_000_000000000000n,
      feeBpsA: 25,
      feeBpsB: 25,
      amountInWpkn: 10_000000000000000000n,
      decimalsWpkn: 18,
      decimalsQuote: 18,
      gasCostQuote: 0n,
    });
    expect(result.direction).not.toBe("none");
  });
});

describe("calculateLiquidityAmounts", () => {
  it("adds proportional quote", () => {
    const { wpkenToAdd, quoteToAdd } = calculateLiquidityAmounts(
      40_000000000000000000n,
      40_000000000000000000n,
      50_000000000000000000n
    );
    expect(wpkenToAdd).toBe(10_000000000000000000n);
    expect(quoteToAdd).toBe(10_000000000000000000n);
  });
});

describe("applySlippageMin", () => {
  it("reduces amount by bps", () => {
    expect(applySlippageMin(10000n, 100)).toBe(9900n);
  });
});

describe("percentDifference", () => {
  it("returns 0 for equal", () => {
    expect(percentDifference(1, 1)).toBe(0);
  });
});
