import { parseNairaToKobo } from '../common/money';

/**
 * Parses a daily partner-bank / NIBSS-style settlement statement:
 *
 *   SESSION_ID,TRAN_DATE,DIRECTION,AMOUNT,NARRATION,CHANNEL
 *   999240261001101500123456789012,2026-10-01 10:15:00,CR,"2,500.00",TRF FROM ADA,NIP
 *
 * - DIRECTION is from the bank's point of view of OUR account:
 *   CR = money into our pool, DR = money out.
 * - TRAN_DATE is Lagos local time (WAT, UTC+1), as banks print it.
 * - AMOUNT is naira with thousands separators, quoted when it has commas.
 */
export interface StatementLine {
  lineNo: number;
  sessionId: string;
  tranTime: Date;
  direction: 'CR' | 'DR';
  amountMinor: bigint;
  narration: string;
}

export class StatementParseError extends Error {}

/** Minimal RFC 4180 field splitter: quotes, escaped quotes, commas inside quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (quoted) throw new StatementParseError('unterminated quoted field');
  out.push(cur);
  return out.map((f) => f.trim());
}

/** "2026-10-01 10:15:00" in WAT -> UTC Date. */
export function parseWatTimestamp(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new StatementParseError(`bad TRAN_DATE "${s}"`);
  const [, y, mo, d, h, mi, sec = '0'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 1, +mi, +sec));
}

const REQUIRED = ['SESSION_ID', 'TRAN_DATE', 'DIRECTION', 'AMOUNT'];

export function parseStatement(csv: string): StatementLine[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.toUpperCase());
  for (const col of REQUIRED) {
    if (!header.includes(col)) throw new StatementParseError(`missing column ${col}`);
  }
  const idx = (c: string) => header.indexOf(c);
  const out: StatementLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = splitCsvLine(lines[i]);
    const lineNo = i + 1;
    const sessionId = f[idx('SESSION_ID')];
    const direction = f[idx('DIRECTION')]?.toUpperCase();
    if (!sessionId) throw new StatementParseError(`line ${lineNo}: empty SESSION_ID`);
    if (direction !== 'CR' && direction !== 'DR') {
      throw new StatementParseError(`line ${lineNo}: DIRECTION must be CR or DR`);
    }
    let amountMinor: bigint;
    try {
      amountMinor = parseNairaToKobo(f[idx('AMOUNT')]);
    } catch {
      throw new StatementParseError(`line ${lineNo}: bad AMOUNT "${f[idx('AMOUNT')]}"`);
    }
    out.push({
      lineNo,
      sessionId,
      tranTime: parseWatTimestamp(f[idx('TRAN_DATE')]),
      direction,
      amountMinor,
      narration: idx('NARRATION') >= 0 ? (f[idx('NARRATION')] ?? '') : '',
    });
  }
  return out;
}
