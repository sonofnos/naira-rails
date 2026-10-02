import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { one, rows } from '../common/db';
import { IdempotencyConflictError, InsufficientFundsError, NotFoundError, ValidationError } from '../common/errors';
import { requestHash } from '../common/hash';
import { OwnerType, SYS, SystemAccountCode, walletCode } from './chart-of-accounts';

export type Direction = 'debit' | 'credit';

export interface PostingLine {
  accountId: string;
  direction: Direction;
  amountMinor: bigint;
}

export interface PostingInput {
  /** Globally unique; a replay with the same key and same lines is a no-op. */
  idempotencyKey: string;
  kind: string;
  /** External reference used by reconciliation (e.g. NIP session ID). */
  reference?: string;
  description?: string;
  lines: PostingLine[];
}

export interface PostingResult {
  journalId: string;
  replayed: boolean;
}

interface LockedAccount {
  id: string;
  code: string;
  normal_side: Direction;
  allow_negative: boolean;
  balance_minor: string;
}

@Injectable()
export class LedgerService {
  private readonly systemIds = new Map<string, string>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Posts a balanced journal.
   *
   * 1. Claim the idempotency key: INSERT ... ON CONFLICT DO NOTHING on the
   *    journal header. A concurrent duplicate blocks on the unique index
   *    until the first commits, then sees the conflict — no app-level
   *    read-then-write window.
   * 2. Lock every touched account with SELECT ... FOR UPDATE in ascending
   *    id order (fixed order => no lock-order deadlocks between postings).
   * 3. Apply deltas against the locked balances, enforce no-overdraft, write
   *    lines. A deferred DB trigger re-checks debits == credits at COMMIT.
   *
   * Pass `manager` to run inside a caller's transaction so the domain row
   * (inbound credit, payout, settlement...) and its journal commit together.
   */
  async post(input: PostingInput, manager?: EntityManager): Promise<PostingResult> {
    this.validate(input);
    if (manager) return this.postWith(manager, input);
    return this.dataSource.transaction((m) => this.postWith(m, input));
  }

  private validate(input: PostingInput): void {
    if (input.lines.length < 2) {
      throw new ValidationError('A journal needs at least two lines');
    }
    let debits = 0n;
    let credits = 0n;
    for (const line of input.lines) {
      if (typeof line.amountMinor !== 'bigint' || line.amountMinor <= 0n) {
        throw new ValidationError('Every journal line must be a positive bigint amount');
      }
      if (line.direction === 'debit') debits += line.amountMinor;
      else credits += line.amountMinor;
    }
    if (debits !== credits) {
      throw new ValidationError(`Unbalanced journal: debits ${debits} != credits ${credits}`);
    }
  }

  private async postWith(m: EntityManager, input: PostingInput): Promise<PostingResult> {
    const hash = requestHash({
      kind: input.kind,
      lines: input.lines.map((l) => [l.accountId, l.direction, l.amountMinor.toString()]),
    });

    const inserted = await one<{ id: string }>(
      m,
      `INSERT INTO journal_transactions (idempotency_key, kind, reference, request_hash, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.idempotencyKey, input.kind, input.reference ?? null, hash, input.description ?? null],
    );

    if (!inserted) {
      const existing = await one<{ id: string; request_hash: string }>(
        m,
        `SELECT id, request_hash FROM journal_transactions WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (!existing) throw new Error('journal conflict but no existing row');
      if (existing.request_hash !== hash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return { journalId: existing.id, replayed: true };
    }

    const ids = [...new Set(input.lines.map((l) => l.accountId))].sort();
    const locked = await rows<LockedAccount>(
      m,
      `SELECT id, code, normal_side, allow_negative, balance_minor
         FROM ledger_accounts WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [ids],
    );
    if (locked.length !== ids.length) throw new NotFoundError('Ledger account');

    const balances = new Map(locked.map((a) => [a.id, BigInt(a.balance_minor)]));
    const byId = new Map(locked.map((a) => [a.id, a]));
    const balanceAfter: bigint[] = [];

    for (const line of input.lines) {
      const account = byId.get(line.accountId)!;
      const increases = line.direction === account.normal_side;
      const next = balances.get(account.id)! + (increases ? line.amountMinor : -line.amountMinor);
      balances.set(account.id, next);
      balanceAfter.push(next);
    }

    for (const account of locked) {
      const next = balances.get(account.id)!;
      if (!account.allow_negative && next < 0n) {
        throw new InsufficientFundsError(account.code);
      }
    }

    for (const account of locked) {
      await m.query(`UPDATE ledger_accounts SET balance_minor = $2 WHERE id = $1`, [
        account.id,
        balances.get(account.id)!.toString(),
      ]);
    }

    const values: string[] = [];
    const params: unknown[] = [inserted.id];
    input.lines.forEach((line, i) => {
      params.push(line.accountId, line.direction, line.amountMinor.toString(), balanceAfter[i].toString());
      const p = params.length;
      values.push(`($1, $${p - 3}, $${p - 2}, $${p - 1}, $${p})`);
    });
    await m.query(
      `INSERT INTO journal_entries (transaction_id, account_id, direction, amount_minor, balance_after_minor)
       VALUES ${values.join(', ')}`,
      params,
    );

    return { journalId: inserted.id, replayed: false };
  }

  /**
   * Takes the posting's row locks up front, in the same ascending-id order
   * post() uses. Needed when the caller inserts a row with a foreign key to
   * ledger_accounts BEFORE posting: the FK check takes FOR KEY SHARE on the
   * referenced account, and two transactions that both hold KEY SHARE and
   * then both ask for FOR UPDATE deadlock on the upgrade (see README).
   */
  async lockAccounts(ids: string[], m: EntityManager): Promise<void> {
    await rows(m, `SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [
      [...new Set(ids)].sort(),
    ]);
  }

  async systemAccountId(code: SystemAccountCode, m?: EntityManager): Promise<string> {
    const cached = this.systemIds.get(code);
    if (cached) return cached;
    const row = await one<{ id: string }>(m ?? this.dataSource, `SELECT id FROM ledger_accounts WHERE code = $1`, [
      code,
    ]);
    if (!row) throw new NotFoundError(`System account ${code}`);
    this.systemIds.set(code, row.id);
    return row.id;
  }

  /** Idempotently creates the owner's NGN wallet (a credit-normal liability). */
  async ensureWallet(ownerType: OwnerType, ownerId: string, m?: EntityManager): Promise<string> {
    const code = walletCode(ownerType, ownerId);
    const db = m ?? this.dataSource;
    await rows(
      db,
      `INSERT INTO ledger_accounts (code, kind, normal_side, owner_type, owner_id, allow_negative)
       VALUES ($1, 'liability', 'credit', $2, $3, false)
       ON CONFLICT (code) DO NOTHING`,
      [code, ownerType, ownerId],
    );
    const row = await one<{ id: string }>(db, `SELECT id FROM ledger_accounts WHERE code = $1`, [code]);
    return row!.id;
  }

  async findWallet(ownerType: OwnerType, ownerId: string): Promise<string | undefined> {
    const row = await one<{ id: string }>(this.dataSource, `SELECT id FROM ledger_accounts WHERE code = $1`, [
      walletCode(ownerType, ownerId),
    ]);
    return row?.id;
  }

  async balanceOf(accountId: string): Promise<bigint> {
    const row = await one<{ balance_minor: string }>(
      this.dataSource,
      `SELECT balance_minor FROM ledger_accounts WHERE id = $1`,
      [accountId],
    );
    if (!row) throw new NotFoundError('Ledger account');
    return BigInt(row.balance_minor);
  }

  async walletBalance(ownerType: OwnerType, ownerId: string): Promise<bigint> {
    const id = await this.findWallet(ownerType, ownerId);
    return id ? this.balanceOf(id) : 0n;
  }

  async statement(accountId: string, limit = 100) {
    return rows(
      this.dataSource,
      `SELECT e.id, e.direction, e.amount_minor, e.balance_after_minor, e.created_at,
              t.kind, t.reference, t.id AS journal_id
         FROM journal_entries e JOIN journal_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1
        ORDER BY e.id DESC
        LIMIT $2`,
      [accountId, limit],
    );
  }

  /**
   * Whole-book integrity check: total debits == total credits, and every
   * account's cached balance equals the sum of its own journal lines.
   */
  async trialBalance() {
    const totals = await one<{ debits: string; credits: string }>(
      this.dataSource,
      `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction='debit'),0)  AS debits,
              COALESCE(SUM(amount_minor) FILTER (WHERE direction='credit'),0) AS credits
         FROM journal_entries`,
    );
    const drift = await rows<{ code: string; cached: string; derived: string }>(
      this.dataSource,
      `SELECT a.code, a.balance_minor AS cached,
              COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0) AS derived
         FROM ledger_accounts a LEFT JOIN journal_entries e ON e.account_id = a.id
        GROUP BY a.id
       HAVING a.balance_minor <> COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)`,
    );
    return {
      debitsMinor: totals!.debits,
      creditsMinor: totals!.credits,
      balanced: totals!.debits === totals!.credits && drift.length === 0,
      accountsWithDrift: drift,
    };
  }

  /** Convenience for building lines. */
  static line(accountId: string, direction: Direction, amountMinor: bigint): PostingLine {
    return { accountId, direction, amountMinor };
  }
}

export { SYS };
