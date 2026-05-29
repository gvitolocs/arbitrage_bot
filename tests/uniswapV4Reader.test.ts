import { describe, expect, it } from "vitest";
import {
  executableV4UsdForGap,
  expectedNativeOutFromWpkn,
  expectedWpknOutFromBnb,
  wpknUsdFromSlot0,
  type V4OnChainSnapshot,
} from "../src/blockchain/uniswapV4Reader.js";
import type { BotConfig } from "../src/config.js";

const config = {
  chainId: 56,
  wpkenAddress: "0x91A17E2bddfF839078BD395482B38e4AC15276f4",
} as BotConfig;

/** Snapshot near tick 66865 on live wPKN/BNB v4 pool (May 2026). */
const liveSnapshot: V4OnChainSnapshot = {
  poolId: "0xce826fc29e6c3d5ffbf30ab4ed68bcd6de43e237ad6485e3f0d76b4075c810bf",
  sqrtPriceX96: 2242749946582002031529034091180n,
  tick: 66865,
  liquidity: 63242412063076n,
  poolExists: true,
};

describe("uniswapV4Reader quotes", () => {
  it("wpknUsdFromSlot0 uses BNB-per-wPKN (high USD when pool tick is above market)", () => {
    const usd = wpknUsdFromSlot0(config, liveSnapshot, 630);
    expect(usd).not.toBeNull();
    expect(usd!).toBeGreaterThan(100);
  });

  it("expectedWpknOutFromBnb scales with BNB in (small wPKN at this tick)", () => {
    const out = expectedWpknOutFromBnb(config, liveSnapshot, 1_000_000_000_000_000n);
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThan(0n);
    expect(out!).toBeLessThan(10n ** 15n);
  });

  it("executableV4UsdForGap ignores Gecko outlier vs Pancake", () => {
    const pancake = 0.78;
    const gapPx = executableV4UsdForGap(config, 3.51, 3.51, liveSnapshot, pancake, 0.0012);
    expect(gapPx).toBeCloseTo(pancake, 6);
  });

  it("expectedNativeOutFromWpkn is consistent with sell direction", () => {
    const wpkn = 1_000_000_000_000_000_000n;
    const out = expectedNativeOutFromWpkn(config, liveSnapshot, wpkn);
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThan(0n);
  });
});
