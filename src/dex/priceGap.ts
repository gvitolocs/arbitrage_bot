/** Cross-pool gap: rebalance when above min until within target (max). */

export function shouldRebalanceForGap(
  diffPercent: number,
  minPercent: number,
  targetMaxPercent: number
): { rebalance: boolean; reason?: string } {
  if (diffPercent <= targetMaxPercent) {
    return {
      rebalance: false,
      reason: `gap ${diffPercent.toFixed(1)}% within target ≤${targetMaxPercent}%`,
    };
  }
  if (diffPercent < minPercent) {
    return {
      rebalance: false,
      reason: `gap ${diffPercent.toFixed(1)}% below min ${minPercent}%`,
    };
  }
  return { rebalance: true };
}

/** @deprecated use shouldRebalanceForGap */
export function isPriceGapActionable(
  diffPercent: number,
  minPercent: number,
  maxPercent: number
): { actionable: boolean; reason?: string } {
  const r = shouldRebalanceForGap(diffPercent, minPercent, maxPercent);
  return { actionable: r.rebalance, reason: r.reason };
}
