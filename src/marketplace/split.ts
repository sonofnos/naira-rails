/**
 * Splits one customer payment for a food order into merchant, rider and
 * platform shares, in integer kobo.
 *
 *   merchant = foodSubtotal - floor(foodSubtotal * commissionBps / 10000)
 *   rider    = floor(deliveryFee * riderShareBps / 10000)
 *   platform = total - merchant - rider   (commission + service fee + delivery remainder)
 *
 * Rounding always floors the merchant's commission and the rider's share and
 * gives the remainder to the platform, so the three shares sum to the total
 * by construction — never off by a kobo.
 */
export interface SplitInput {
  foodSubtotalMinor: bigint;
  deliveryFeeMinor: bigint;
  serviceFeeMinor: bigint;
  commissionBps: number;
  riderShareBps: number;
}

export interface SplitResult {
  totalMinor: bigint;
  merchantMinor: bigint;
  riderMinor: bigint;
  platformMinor: bigint;
}

export function computeSplit(i: SplitInput): SplitResult {
  for (const [k, v] of Object.entries({
    foodSubtotalMinor: i.foodSubtotalMinor,
    deliveryFeeMinor: i.deliveryFeeMinor,
    serviceFeeMinor: i.serviceFeeMinor,
  })) {
    if (v < 0n) throw new Error(`${k} must not be negative`);
  }
  for (const [k, v] of Object.entries({ commissionBps: i.commissionBps, riderShareBps: i.riderShareBps })) {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${k} must be an integer 0..10000`);
  }
  const totalMinor = i.foodSubtotalMinor + i.deliveryFeeMinor + i.serviceFeeMinor;
  if (totalMinor <= 0n) throw new Error('order total must be positive');
  const commission = (i.foodSubtotalMinor * BigInt(i.commissionBps)) / 10_000n;
  const merchantMinor = i.foodSubtotalMinor - commission;
  const riderMinor = (i.deliveryFeeMinor * BigInt(i.riderShareBps)) / 10_000n;
  const platformMinor = totalMinor - merchantMinor - riderMinor;
  return { totalMinor, merchantMinor, riderMinor, platformMinor };
}
