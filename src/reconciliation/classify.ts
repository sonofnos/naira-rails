import { StatementLine } from './statement-parser';

export type ReconStatus =
  'matched' | 'amount_mismatch' | 'missing_in_ledger' | 'missing_in_statement' | 'duplicate_in_statement';

/** A settlement-bank journal line, translated into the bank's CR/DR view. */
export interface LedgerLine {
  reference: string;
  direction: 'CR' | 'DR';
  amountMinor: bigint;
  postedAt: Date;
  /** Posted inside the business day being reconciled (WAT). */
  inWindow: boolean;
}

export interface ReconItem {
  status: ReconStatus;
  sessionId: string;
  direction: 'CR' | 'DR';
  statementMinor: bigint | null;
  ledgerMinor: bigint | null;
  note?: string;
}

/**
 * Matches statement lines to ledger lines on (session ID, direction).
 *
 * - Ledger lines are supplied for the business day plus a day either side,
 *   so a credit the bank stamped 23:59:58 that we posted at 00:00:01 still
 *   matches (flagged cross_day) instead of showing up as two breaks.
 * - Only ledger lines inside the business day can be `missing_in_statement`;
 *   neighbours outside it belong to another day's run.
 * - A missing_in_ledger DR whose session ID belongs to a payout still
 *   awaiting a TSQ answer is annotated: the statement is evidence the
 *   transfer left the pool, which is how ops resolves needs_review payouts.
 */
export function classify(
  statement: StatementLine[],
  ledger: LedgerLine[],
  unresolvedPayoutSessions: Set<string> = new Set(),
): ReconItem[] {
  const key = (ref: string, dir: string) => `${ref}|${dir}`;
  const ledgerByKey = new Map<string, LedgerLine[]>();
  for (const l of ledger) {
    const k = key(l.reference, l.direction);
    ledgerByKey.set(k, [...(ledgerByKey.get(k) ?? []), l]);
  }

  const items: ReconItem[] = [];
  const seenStatement = new Set<string>();
  const consumed = new Set<LedgerLine>();

  for (const s of statement) {
    const k = key(s.sessionId, s.direction);
    if (seenStatement.has(k)) {
      items.push({
        status: 'duplicate_in_statement',
        sessionId: s.sessionId,
        direction: s.direction,
        statementMinor: s.amountMinor,
        ledgerMinor: null,
        note: `line ${s.lineNo}`,
      });
      continue;
    }
    seenStatement.add(k);

    const candidate = (ledgerByKey.get(k) ?? []).find((l) => !consumed.has(l));
    if (!candidate) {
      items.push({
        status: 'missing_in_ledger',
        sessionId: s.sessionId,
        direction: s.direction,
        statementMinor: s.amountMinor,
        ledgerMinor: null,
        note:
          s.direction === 'DR' && unresolvedPayoutSessions.has(s.sessionId)
            ? 'unresolved_payout: statement shows the transfer left the pool'
            : undefined,
      });
      continue;
    }
    consumed.add(candidate);
    items.push({
      status: candidate.amountMinor === s.amountMinor ? 'matched' : 'amount_mismatch',
      sessionId: s.sessionId,
      direction: s.direction,
      statementMinor: s.amountMinor,
      ledgerMinor: candidate.amountMinor,
      note: candidate.inWindow ? undefined : 'cross_day',
    });
  }

  for (const l of ledger) {
    if (l.inWindow && !consumed.has(l)) {
      items.push({
        status: 'missing_in_statement',
        sessionId: l.reference,
        direction: l.direction,
        statementMinor: null,
        ledgerMinor: l.amountMinor,
      });
    }
  }
  return items;
}

export function summarize(items: ReconItem[]): Record<ReconStatus, number> {
  const s: Record<ReconStatus, number> = {
    matched: 0,
    amount_mismatch: 0,
    missing_in_ledger: 0,
    missing_in_statement: 0,
    duplicate_in_statement: 0,
  };
  for (const i of items) s[i.status]++;
  return s;
}
