import { convertToKobo, normalizeTxHash } from './offramp-client';

describe('off-ramp helpers', () => {
  const evm = '0x' + 'AbCdEf0123456789'.repeat(4);

  it('normalises case-insensitive hex hashes so letter case cannot dodge the unique constraint', () => {
    expect(normalizeTxHash('ethereum', evm)).toBe(evm.toLowerCase());
    expect(normalizeTxHash('ethereum', evm.toLowerCase())).toBe(
      normalizeTxHash('ethereum', evm.toUpperCase().replace('0X', '0x')),
    );
    expect(normalizeTxHash('tron', evm.slice(2).toUpperCase())).toBe(evm.slice(2).toLowerCase());
  });

  it('leaves case-sensitive Solana signatures untouched', () => {
    const sig = '5'.repeat(44) + 'aBcDeFgHiJkLmNoPqRsT';
    expect(normalizeTxHash('solana', sig)).toBe(sig);
  });

  it('rejects malformed hashes', () => {
    expect(() => normalizeTxHash('ethereum', '0x1234')).toThrow();
    expect(() => normalizeTxHash('solana', '0OIl' + 'a'.repeat(60))).toThrow();
  });

  it('converts token base units to kobo in integer math, flooring dust', () => {
    // 25 USDT at ₦1,550.00 = ₦38,750.00
    expect(convertToKobo('USDT', 25_000_000n, 155_000n)).toBe(3_875_000n);
    // 0.000001 USDT is worth 0.155 kobo -> 0
    expect(convertToKobo('USDT', 1n, 155_000n)).toBe(0n);
    // 1.234567 USDT at ₦1,550.00 = 191,357.885 kobo -> 191,357
    expect(convertToKobo('USDC', 1_234_567n, 155_000n)).toBe(191_357n);
  });
});
