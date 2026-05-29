import { describe, expect, it } from "vitest";
import { shouldRebalanceForGap } from "../src/dex/priceGap.js";

describe("shouldRebalanceForGap", () => {
  it("rebalances when gap above target (align prices)", () => {
    expect(shouldRebalanceForGap(189, 2, 10).rebalance).toBe(true);
    expect(shouldRebalanceForGap(15, 2, 10).rebalance).toBe(true);
  });

  it("stops when gap within target", () => {
    expect(shouldRebalanceForGap(5, 2, 10).rebalance).toBe(false);
    expect(shouldRebalanceForGap(10, 2, 10).rebalance).toBe(false);
  });
});
