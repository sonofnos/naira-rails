import { parseNairaToKobo } from '../common/money';
import { LedgerLine, classify, summarize } from './classify';
import { parseStatement, parseWatTimestamp, splitCsvLine } from './statement-parser';

const S1 = '999240261001101500000000000001';
const S2 = '999240261001101500000000000002';
const S3 = '999240261001101500000000000003';
const S4 = '999240261001101500000000000004';
const S5 = '999240261001101500000000000005';

const ledger = (reference: string, direction: 'CR' | 'DR', amount: bigint, inWindow = true): LedgerLine => ({
  reference,
  direction,
  amountMinor: amount,
  postedAt: new Date(),
  inWindow,
});

describe('money parsing (no floats)', () => {
  it('parses bank-formatted naira exactly', () => {
    expect(parseNairaToKobo('2,500.00')).toBe(250_000n);
    expect(parseNairaToKobo('1234.56')).toBe(123_456n); // parseFloat*100 gives 123455.99999999999
    expect(parseNairaToKobo('0.1')).toBe(10n);
    expect(parseNairaToKobo('NGN 19,999.99')).toBe(1_999_999n);
    expect(() => parseNairaToKobo('12.345')).toThrow();
    expect(() => parseNairaToKobo('abc')).toThrow();
  });
});

describe('statement parser', () => {
  it('splits quoted CSV fields with commas and escaped quotes', () => {
    expect(splitCsvLine('a,"2,500.00","say ""hi""",d')).toEqual(['a', '2,500.00', 'say "hi"', 'd']);
  });

  it('reads TRAN_DATE as Lagos time', () => {
    expect(parseWatTimestamp('2026-10-01 00:30:00').toISOString()).toBe('2026-09-30T23:30:00.000Z');
  });

  it('parses a statement and rejects bad rows with a line number', () => {
    const csv = [
      'SESSION_ID,TRAN_DATE,DIRECTION,AMOUNT,NARRATION,CHANNEL',
      `${S1},2026-10-01 10:15:00,CR,"2,500.00",TRF FROM ADA,NIP`,
      `${S2},2026-10-01 11:00:00,DR,800.50,RIDER PAYOUT,NIP`,
      '',
    ].join('\r\n');
    const lines = parseStatement(csv);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ sessionId: S1, direction: 'CR', amountMinor: 250_000n, lineNo: 2 });
    expect(lines[1]).toMatchObject({ direction: 'DR', amountMinor: 80_050n });

    expect(() => parseStatement(`SESSION_ID,TRAN_DATE,DIRECTION,AMOUNT\n${S1},2026-10-01 10:00,XX,1.00`)).toThrow(
      'line 2',
    );
    expect(() => parseStatement('SESSION_ID,AMOUNT\n')).toThrow('missing column');
  });
});

describe('reconciliation classification', () => {
  const stmt = (sessionId: string, direction: 'CR' | 'DR', amount: bigint, lineNo = 2) => ({
    lineNo,
    sessionId,
    direction,
    amountMinor: amount,
    tranTime: new Date(),
    narration: '',
  });

  it('classifies every bucket', () => {
    const items = classify(
      [stmt(S1, 'CR', 250_000n), stmt(S2, 'CR', 100_000n), stmt(S3, 'DR', 50_000n), stmt(S3, 'DR', 50_000n, 9)],
      [ledger(S1, 'CR', 250_000n), ledger(S2, 'CR', 99_999n), ledger(S3, 'DR', 50_000n), ledger(S4, 'CR', 7_000n)],
    );
    expect(summarize(items)).toEqual({
      matched: 2,
      amount_mismatch: 1,
      missing_in_ledger: 0,
      missing_in_statement: 1,
      duplicate_in_statement: 1,
    });
    expect(items.find((i) => i.status === 'amount_mismatch')).toMatchObject({
      sessionId: S2,
      statementMinor: 100_000n,
      ledgerMinor: 99_999n,
    });
    expect(items.find((i) => i.status === 'missing_in_statement')!.sessionId).toBe(S4);
  });

  it('matches across the midnight boundary instead of reporting two breaks', () => {
    const items = classify([stmt(S1, 'CR', 10_000n)], [ledger(S1, 'CR', 10_000n, false)]);
    expect(items).toEqual([expect.objectContaining({ status: 'matched', note: 'cross_day' })]);
  });

  it('ledger lines outside the business day are never missing_in_statement for this run', () => {
    expect(classify([], [ledger(S1, 'CR', 10_000n, false)])).toEqual([]);
  });

  it('the same session in opposite directions does not match', () => {
    const items = classify([stmt(S1, 'CR', 10_000n)], [ledger(S1, 'DR', 10_000n)]);
    expect(summarize(items)).toMatchObject({ missing_in_ledger: 1, missing_in_statement: 1, matched: 0 });
  });

  it('flags a statement debit that belongs to a payout still awaiting requery', () => {
    const items = classify([stmt(S5, 'DR', 25_000n)], [], new Set([S5]));
    expect(items[0]).toMatchObject({ status: 'missing_in_ledger', note: expect.stringContaining('unresolved_payout') });
  });
});
