export function isLuhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export type CardBrand = 'verve' | 'mastercard' | 'visa' | 'unknown';

/**
 * Verve (Interswitch's domestic scheme) BIN ranges: 506099–506198, 650002–650027,
 * 507865–507964. Checked before Mastercard/Visa because Verve cards are the
 * ones that, in practice, always step up to PIN/OTP in Nigeria.
 */
export function detectBrand(pan: string): CardBrand {
  const six = Number(pan.slice(0, 6));
  if ((six >= 506099 && six <= 506198) || (six >= 650002 && six <= 650027) || (six >= 507865 && six <= 507964)) {
    return 'verve';
  }
  const two = Number(pan.slice(0, 2));
  const four = Number(pan.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return 'mastercard';
  if (pan.startsWith('4')) return 'visa';
  return 'unknown';
}

export function isExpired(month: number, year: number, now = new Date()): boolean {
  const fullYear = year < 100 ? 2000 + year : year;
  // Cards are valid through the last day of the expiry month.
  const firstOfNextMonth = Date.UTC(fullYear, month, 1);
  return now.getTime() >= firstOfNextMonth;
}
