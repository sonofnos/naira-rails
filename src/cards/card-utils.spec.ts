import { maskPan, redactObject, redactPans } from '../common/redact';
import { detectBrand, isExpired, isLuhnValid } from './card-utils';

describe('card utilities', () => {
  it('Luhn', () => {
    expect(isLuhnValid('4084084084084081')).toBe(true);
    expect(isLuhnValid('4084084084084082')).toBe(false);
    expect(isLuhnValid('5061020000000000094')).toBe(true); // 19-digit Verve
    expect(isLuhnValid('12345')).toBe(false);
  });

  it('brand detection puts Verve ahead of Mastercard ranges', () => {
    expect(detectBrand('5061020000000000094')).toBe('verve');
    expect(detectBrand('5399830000000008')).toBe('mastercard');
    expect(detectBrand('2221000000000009')).toBe('mastercard');
    expect(detectBrand('4084084084084081')).toBe('visa');
  });

  it('a card is valid through the end of its expiry month', () => {
    expect(isExpired(10, 26, new Date('2026-10-31T23:59:59Z'))).toBe(false);
    expect(isExpired(10, 26, new Date('2026-11-01T00:00:00Z'))).toBe(true);
    expect(isExpired(12, 2026, new Date('2026-12-15T00:00:00Z'))).toBe(false);
  });

  it('masks PANs to first6/last4', () => {
    expect(maskPan('4084084084084081')).toBe('408408******4081');
    expect(maskPan('5061020000000000094')).toBe('506102*********0094');
  });

  it('redacts PAN-shaped, Luhn-valid digit runs from free text but leaves other numbers alone', () => {
    const line = 'charge failed pan=4084 0840 8408 4081 session=999240261002003000123456789012 amount=250000';
    const out = redactPans(line);
    expect(out).not.toContain('4084 0840 8408 4081');
    expect(out).toContain('408408******4081');
    expect(out).toContain('999240261002003000123456789012'); // 30-digit session id is not a PAN
    expect(out).toContain('250000');
  });

  it('redacts sensitive keys in objects', () => {
    expect(redactObject({ pan: '4084084084084081', cvv: '408', nested: { note: 'card 4084084084084081' } })).toEqual({
      pan: '[REDACTED]',
      cvv: '[REDACTED]',
      nested: { note: 'card 408408******4081' },
    });
  });
});
