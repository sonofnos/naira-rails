/**
 * Money is carried as bigint kobo (minor units) everywhere inside the
 * service. Floats never touch an amount: bank files and webhooks send naira
 * as decimal strings ("2,500.50"), and parseFloat("1234.56") * 100 is
 * 123455.99999999999 — a one-kobo reconciliation break waiting to happen.
 */
const NAIRA_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function parseNairaToKobo(input: string | number): bigint {
  if (typeof input === 'number') {
    // Numbers are only accepted when they are already exact integers of
    // naira-with-two-decimals; route them through the string parser so the
    // same rules apply.
    input = input.toFixed(2);
  }
  const cleaned = input
    .trim()
    .replace(/,/g, '')
    .replace(/^NGN\s*/i, '');
  const match = NAIRA_PATTERN.exec(cleaned);
  if (!match) {
    throw new Error(`Invalid naira amount: "${input}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  const kobo = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -kobo : kobo;
}

export function formatKobo(kobo: bigint): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function toKobo(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`amountMinor must be a safe integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`amountMinor must be an integer string, got "${value}"`);
  }
  return BigInt(value);
}
