/**
 * NIP response codes (ISO 8583-derived) and — the part that actually
 * matters — how a payout must react to each.
 *
 * The rule of Nigerian bank transfers: an ambiguous outcome is NOT a
 * failure. A timeout, "status unknown" or "system malfunction" may well mean
 * the beneficiary was credited. Refunding the wallet (or worse, re-sending)
 * on those codes is how a business pays a rider twice. Ambiguous outcomes
 * go to requery (TSQ) on the same session ID until a definitive answer.
 */
export const NIP_CODES: Record<string, string> = {
  '00': 'Approved or completed successfully',
  '01': 'Status unknown, please wait for settlement report',
  '03': 'Invalid sender',
  '05': 'Do not honor',
  '06': 'Dormant account',
  '07': 'Invalid account',
  '08': 'Account name mismatch',
  '09': 'Request processing in progress',
  '12': 'Invalid transaction',
  '13': 'Invalid amount',
  '25': 'Unable to locate record',
  '26': 'Duplicate record',
  '51': 'No sufficient funds',
  '57': 'Transaction not permitted to sender',
  '61': 'Transfer limit exceeded',
  '91': 'Beneficiary bank not available',
  '94': 'Duplicate transaction',
  '96': 'System malfunction',
  '97': 'Timeout waiting for response from destination',
};

export type NipOutcome = 'success' | 'failed' | 'ambiguous' | 'not_found';

/** Codes that prove the transfer did not and will not happen. */
const DEFINITIVE_FAILURES = new Set(['03', '05', '06', '07', '08', '12', '13', '51', '57', '61']);

/**
 * Classify a code returned by FT or TSQ.
 *
 * - '94'/'26' on FT means NIBSS already has this session ID: something sent
 *   it before (a crashed worker, a proxy retry). Never a failure — requery.
 * - '25' is only meaningful on TSQ: NIBSS has no record of the session. It is
 *   reported as `not_found` and the caller decides (see `decideAfterStatusQuery`).
 * - Anything unrecognised is ambiguous. Unknown never maps to failed.
 */
export function classifyNipCode(code: string): NipOutcome {
  if (code === '00') return 'success';
  if (DEFINITIVE_FAILURES.has(code)) return 'failed';
  if (code === '25') return 'not_found';
  return 'ambiguous';
}

export interface RequeryPolicy {
  /**
   * How long after the FT was sent a TSQ "25 not found" can be trusted to
   * mean the FT never reached NIBSS. Before this, NIBSS may simply not have
   * recorded it yet.
   */
  notFoundGraceMs: number;
  /** After this many inconclusive requeries, stop and escalate to a human. */
  maxRequeries: number;
}

export type RequeryDecision = 'success' | 'failed' | 'retry_later' | 'needs_review';

export function decideAfterStatusQuery(
  code: string,
  msSinceSent: number,
  requeryCount: number,
  policy: RequeryPolicy,
): RequeryDecision {
  const outcome = classifyNipCode(code);
  if (outcome === 'success') return 'success';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'not_found' && msSinceSent >= policy.notFoundGraceMs) return 'failed';
  // Escalate rather than guess: an operator resolves it from the NIBSS
  // settlement report / reconciliation, never an automatic refund.
  if (requeryCount + 1 >= policy.maxRequeries) return 'needs_review';
  return 'retry_later';
}
