import { isLuhnValid } from '../cards/card-utils';

/**
 * Last line of defence for logs: any 12–19 digit run that passes Luhn is
 * treated as a PAN and masked to first6/last4. The primary control is that
 * raw PANs never reach a logger or the database in the first place (they go
 * straight to the processor's vault); this catches the accidental
 * `logger.log(JSON.stringify(body))` someone adds during an incident.
 */
const DIGIT_RUN = /\d[\d -]{10,22}\d/g;

export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 12) return '*'.repeat(digits.length);
  return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
}

export function redactPans(text: string): string {
  return text.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/[ -]/g, '');
    if (digits.length < 12 || digits.length > 19) return run;
    return isLuhnValid(digits) ? maskPan(digits) : run;
  });
}

const SENSITIVE_KEYS = new Set(['pan', 'cvv', 'cvv2', 'pin', 'otp', 'cardnumber']);

/** Deep-copies a value with sensitive keys blanked and PAN-shaped strings masked. */
export function redactObject(value: unknown): unknown {
  if (typeof value === 'string') return redactPans(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactObject(v);
    }
    return out;
  }
  return value;
}
