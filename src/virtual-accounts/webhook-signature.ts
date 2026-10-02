import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Partner-bank webhook signature: hex HMAC-SHA512 of the exact raw request
 * bytes (the same scheme Paystack uses for x-paystack-signature). Computed
 * over the raw body, never a re-serialised JSON object — re-serialising
 * changes key order/whitespace and breaks valid signatures.
 */
export function signWebhook(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export function verifyWebhook(rawBody: Buffer | undefined, signature: unknown, secret: string): boolean {
  if (!rawBody || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = Buffer.from(signWebhook(rawBody, secret), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
