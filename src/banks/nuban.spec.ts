import { buildNuban, isValidNuban, nubanCheckDigit } from './nuban';

describe('NUBAN check digit', () => {
  it('computes the check digit with the 3-7-3 weights over bank code + serial', () => {
    // 0*3+5*7+8*3 + 0*3+0*7+0*3 + 0*3+0*7+0*3 + 0*3+0*7+1*3 = 35+24+3 = 62 -> 10-2 = 8
    expect(nubanCheckDigit('058', '000000001')).toBe(8);
    // sum % 10 == 0 must give 0, not 10
    // 0*3+4*7+4*3 = 40 -> (10 - 0) % 10 = 0
    expect(nubanCheckDigit('044', '000000000')).toBe(0);
  });

  it('round-trips: every built NUBAN validates, and any single-digit change is rejected', () => {
    for (const serial of [1, 42, 123456789, 900000017]) {
      const nuban = buildNuban('035', serial);
      expect(nuban).toHaveLength(10);
      expect(isValidNuban('035', nuban)).toBe(true);
      for (let i = 0; i < 10; i++) {
        const mutated = nuban.slice(0, i) + ((Number(nuban[i]) + 1) % 10) + nuban.slice(i + 1);
        expect(isValidNuban('035', mutated)).toBe(false);
      }
    }
  });

  it('is bank-specific: the same digits are not valid for every bank', () => {
    const nuban = buildNuban('058', 1);
    expect(isValidNuban('058', nuban)).toBe(true);
    expect(isValidNuban('044', nuban)).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isValidNuban('058', '12345')).toBe(false);
    expect(() => buildNuban('058', 1_000_000_000)).toThrow('overflow');
  });
});
