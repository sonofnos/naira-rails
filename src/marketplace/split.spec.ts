import { computeSplit } from './split';

describe('computeSplit', () => {
  it('splits a typical Lagos order', () => {
    // ₦8,500 food, ₦1,200 delivery, ₦300 service; 15% commission; rider keeps 80% of delivery
    const s = computeSplit({
      foodSubtotalMinor: 850_000n,
      deliveryFeeMinor: 120_000n,
      serviceFeeMinor: 30_000n,
      commissionBps: 1500,
      riderShareBps: 8000,
    });
    expect(s).toEqual({
      totalMinor: 1_000_000n,
      merchantMinor: 722_500n,
      riderMinor: 96_000n,
      platformMinor: 181_500n,
    });
  });

  it('rounding remainders go to the platform and shares always sum to the total', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let k = 0; k < 5_000; k++) {
      const s = computeSplit({
        foodSubtotalMinor: BigInt(rand(5_000_000) + 1),
        deliveryFeeMinor: BigInt(rand(300_000)),
        serviceFeeMinor: BigInt(rand(50_000)),
        commissionBps: rand(10_001),
        riderShareBps: rand(10_001),
      });
      expect(s.merchantMinor + s.riderMinor + s.platformMinor).toBe(s.totalMinor);
      expect(s.merchantMinor >= 0n && s.riderMinor >= 0n && s.platformMinor >= 0n).toBe(true);
    }
  });

  it('odd kobo: 1 kobo commission floor stays with the merchant', () => {
    const s = computeSplit({
      foodSubtotalMinor: 333n,
      deliveryFeeMinor: 1n,
      serviceFeeMinor: 0n,
      commissionBps: 1000,
      riderShareBps: 5000,
    });
    expect(s.merchantMinor).toBe(300n); // commission floor(33.3) = 33
    expect(s.riderMinor).toBe(0n); // floor(0.5)
    expect(s.platformMinor).toBe(34n);
  });

  it('rejects nonsense', () => {
    const base = {
      foodSubtotalMinor: 100n,
      deliveryFeeMinor: 0n,
      serviceFeeMinor: 0n,
      commissionBps: 0,
      riderShareBps: 0,
    };
    expect(() => computeSplit({ ...base, commissionBps: 10_001 })).toThrow();
    expect(() => computeSplit({ ...base, foodSubtotalMinor: -1n })).toThrow();
    expect(() => computeSplit({ ...base, foodSubtotalMinor: 0n })).toThrow('positive');
  });
});
