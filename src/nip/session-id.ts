import { randomInt } from 'crypto';

/**
 * NIP session IDs are 30 digits:
 *   6  originating institution code
 *   12 timestamp yyMMddHHmmss (Lagos time, WAT = UTC+1, no DST)
 *   12 unique digits
 *
 * The session ID is the end-to-end key for a transfer: the same one goes on
 * the FT, every TSQ, the beneficiary bank's credit and the NIBSS settlement
 * report — which is why reconciliation matches on it.
 */
export function generateSessionId(institutionCode: string, now = new Date()): string {
  if (!/^\d{6}$/.test(institutionCode)) throw new Error('institution code must be 6 digits');
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  const p = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    p(wat.getUTCFullYear() % 100) +
    p(wat.getUTCMonth() + 1) +
    p(wat.getUTCDate()) +
    p(wat.getUTCHours()) +
    p(wat.getUTCMinutes()) +
    p(wat.getUTCSeconds());
  let unique = '';
  for (let i = 0; i < 12; i++) unique += randomInt(0, 10).toString();
  return institutionCode + stamp + unique;
}

export function isSessionId(value: string): boolean {
  return /^\d{30}$/.test(value);
}
