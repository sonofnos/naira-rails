import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { one, rows } from '../common/db';
import { NotFoundError, ValidationError } from '../common/errors';
import { SYS } from '../ledger/chart-of-accounts';
import { LedgerService } from '../ledger/ledger.service';
import { PayoutsService } from '../payouts/payouts.service';
import { LedgerLine, classify, summarize } from './classify';
import { StatementParseError, parseStatement } from './statement-parser';

export interface ReconRunView {
  id: string;
  businessDate: string;
  summary: Record<string, number>;
  items: Record<string, unknown>[];
}

const WAT_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** [start, end) of a Lagos business day, in UTC. */
export function businessDayWindow(date: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('businessDate must be YYYY-MM-DD');
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(midnightUtc)) throw new ValidationError('businessDate is not a real date');
  const start = new Date(midnightUtc - WAT_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

@Injectable()
export class ReconciliationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
  ) {}

  /**
   * Reconciles one business day's settlement statement against journal lines
   * on SYS:SETTLEMENT_BANK. Re-uploading the same file for the same day
   * returns the existing run (UNIQUE(business_date, file_sha256)).
   */
  async run(businessDate: string, csv: string): Promise<ReconRunView & { replayed: boolean }> {
    const { start, end } = businessDayWindow(businessDate);
    const sha = createHash('sha256').update(csv).digest('hex');
    const existing = await one(
      this.dataSource,
      `SELECT * FROM recon_runs WHERE business_date = $1 AND file_sha256 = $2`,
      [businessDate, sha],
    );
    if (existing) return { ...(await this.get(existing.id)), replayed: true };

    let statement;
    try {
      statement = parseStatement(csv);
    } catch (err) {
      if (err instanceof StatementParseError) throw new ValidationError(`Statement: ${err.message}`);
      throw err;
    }

    const bankId = await this.ledger.systemAccountId(SYS.SETTLEMENT_BANK);
    // A debit to our bank asset is money IN, i.e. a CR on the bank's statement.
    const ledgerRows = await rows<{ reference: string; direction: string; amount_minor: string; created_at: Date }>(
      this.dataSource,
      `SELECT t.reference, e.direction, e.amount_minor, e.created_at
         FROM journal_entries e JOIN journal_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1 AND t.reference IS NOT NULL
          AND e.created_at >= $2 AND e.created_at < $3`,
      [bankId, new Date(start.getTime() - DAY_MS), new Date(end.getTime() + DAY_MS)],
    );
    const ledgerLines: LedgerLine[] = ledgerRows.map((r) => ({
      reference: r.reference,
      direction: r.direction === 'debit' ? 'CR' : 'DR',
      amountMinor: BigInt(r.amount_minor),
      postedAt: new Date(r.created_at),
      inWindow: new Date(r.created_at) >= start && new Date(r.created_at) < end,
    }));

    const items = classify(statement, ledgerLines, new Set(await this.payouts.pendingSessionIds()));
    const summary = summarize(items);

    const runId = await this.dataSource.transaction(async (m) => {
      const run = await one<{ id: string }>(
        m,
        `INSERT INTO recon_runs (business_date, file_sha256, summary) VALUES ($1, $2, $3)
         ON CONFLICT (business_date, file_sha256) DO NOTHING RETURNING id`,
        [businessDate, sha, JSON.stringify(summary)],
      );
      if (!run) return undefined;
      for (const i of items) {
        await m.query(
          `INSERT INTO recon_items (run_id, status, session_id, statement_minor, ledger_minor, direction, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            run.id,
            i.status,
            i.sessionId,
            i.statementMinor?.toString() ?? null,
            i.ledgerMinor?.toString() ?? null,
            i.direction,
            i.note ?? null,
          ],
        );
      }
      return run.id;
    });
    if (!runId) return this.run(businessDate, csv); // concurrent upload of the same file won
    return { ...(await this.get(runId)), replayed: false };
  }

  async get(runId: string): Promise<ReconRunView> {
    const run = await one(this.dataSource, `SELECT * FROM recon_runs WHERE id = $1`, [runId]);
    if (!run) throw new NotFoundError('Reconciliation run');
    const items = await rows(
      this.dataSource,
      `SELECT status, session_id AS "sessionId", direction, statement_minor AS "statementMinor",
              ledger_minor AS "ledgerMinor", note
         FROM recon_items WHERE run_id = $1 ORDER BY status, session_id`,
      [runId],
    );
    return {
      id: run.id,
      businessDate: run.business_date,
      summary: run.summary,
      items,
    };
  }
}
