import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { rows } from '../src/common/db';
import { SYS } from '../src/ledger/chart-of-accounts';
import { LedgerService } from '../src/ledger/ledger.service';
import { createTestApp, expectBooksBalanced, resetState } from './helpers';

describe('Double-entry ledger (real Postgres)', () => {
  let app: INestApplication;
  let ledger: LedgerService;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ledger = app.get(LedgerService);
    ds = app.get(DataSource);
  });
  afterAll(() => app.close());
  beforeEach(() => resetState(app));

  async function fund(ownerId: string, amount: bigint) {
    const wallet = await ledger.ensureWallet('customer', ownerId);
    const bank = await ledger.systemAccountId(SYS.SETTLEMENT_BANK);
    await ledger.post({
      idempotencyKey: `fund:${ownerId}`,
      kind: 'test_fund',
      lines: [LedgerService.line(bank, 'debit', amount), LedgerService.line(wallet, 'credit', amount)],
    });
    return wallet;
  }

  it('50 concurrent debits racing for one balance: exactly the affordable number succeed, never negative', async () => {
    const a = await fund('alice', 10_000n);
    const b = await ledger.ensureWallet('merchant', 'bukka');

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        ledger.post({
          idempotencyKey: `race:${i}`,
          kind: 'transfer',
          lines: [LedgerService.line(a, 'debit', 300n), LedgerService.line(b, 'credit', 300n)],
        }),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toBe(33); // floor(10000 / 300)
    expect(rejected.every((r) => r.reason.code === 'insufficient_funds')).toBe(true);
    expect(await ledger.balanceOf(a)).toBe(100n);
    expect(await ledger.balanceOf(b)).toBe(9_900n);
    await expectBooksBalanced(app);
  });

  it('opposite-direction transfers between the same two wallets do not deadlock (ordered locking)', async () => {
    const a = await fund('a', 1_000_000n);
    const b = await fund('b', 1_000_000n);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ledger.post({
          idempotencyKey: `xfer:${i}`,
          kind: 'transfer',
          lines:
            i % 2 === 0
              ? [LedgerService.line(a, 'debit', 7n), LedgerService.line(b, 'credit', 7n)]
              : [LedgerService.line(b, 'debit', 5n), LedgerService.line(a, 'credit', 5n)],
        }),
      ),
    );
    expect(await ledger.balanceOf(a)).toBe(1_000_000n - 20n * 7n + 20n * 5n);
    expect(await ledger.balanceOf(b)).toBe(1_000_000n + 20n * 7n - 20n * 5n);
    await expectBooksBalanced(app);
  });

  it('the same idempotency key posted 20 times in parallel moves money once', async () => {
    const a = await fund('carol', 5_000n);
    const b = await ledger.ensureWallet('rider', 'r1');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ledger.post({
          idempotencyKey: 'same-key',
          kind: 'transfer',
          lines: [LedgerService.line(a, 'debit', 1_000n), LedgerService.line(b, 'credit', 1_000n)],
        }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.journalId)).size).toBe(1);
    expect(await ledger.balanceOf(a)).toBe(4_000n);
  });

  it('reusing a key with different lines is a conflict, not a silent replay', async () => {
    const a = await fund('dan', 5_000n);
    const b = await ledger.ensureWallet('rider', 'r2');
    const post = (amount: bigint) =>
      ledger.post({
        idempotencyKey: 'k1',
        kind: 'transfer',
        lines: [LedgerService.line(a, 'debit', amount), LedgerService.line(b, 'credit', amount)],
      });
    await post(100n);
    await expect(post(200n)).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('rejects unbalanced journals in the service, and the database rejects them at COMMIT too', async () => {
    const a = await fund('erin', 5_000n);
    const bank = await ledger.systemAccountId(SYS.SETTLEMENT_BANK);
    await expect(
      ledger.post({
        idempotencyKey: 'bad',
        kind: 'x',
        lines: [LedgerService.line(a, 'debit', 10n), LedgerService.line(bank, 'credit', 9n)],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // Bypass the service entirely: the deferred constraint trigger still refuses.
    await expect(
      ds.transaction(async (m) => {
        const [{ id }] = await m.query(
          `INSERT INTO journal_transactions (idempotency_key, kind, request_hash) VALUES ('raw','raw','x') RETURNING id`,
        );
        await m.query(
          `INSERT INTO journal_entries (transaction_id, account_id, direction, amount_minor, balance_after_minor)
           VALUES ($1, $2, 'debit', 10, 0), ($1, $3, 'credit', 9, 0)`,
          [id, a, bank],
        );
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('journal lines are append-only and wallets cannot be overdrawn even by raw SQL', async () => {
    const a = await fund('fola', 5_000n);
    await expect(ds.query(`UPDATE journal_entries SET amount_minor = 1`)).rejects.toThrow(/append-only/);
    await expect(ds.query(`DELETE FROM journal_entries`)).rejects.toThrow(/append-only/);
    await expect(ds.query(`UPDATE ledger_accounts SET balance_minor = -1 WHERE id = $1`, [a])).rejects.toThrow(
      /no_overdraft/,
    );
  });

  it('pins the TypeORM raw-query quirk that rows() exists to avoid', async () => {
    const a = await fund('gbenga', 1n);
    const sql = `UPDATE ledger_accounts SET balance_minor = balance_minor WHERE id = $1 AND false RETURNING id`;
    // No row matched, yet manager.query returns a 2-element array: [rows, rowCount].
    const raw = await ds.manager.query(sql, [a]);
    expect(raw).toEqual([[], 0]);
    expect(raw.length).toBe(2);
    // rows() returns the actual (empty) row set.
    expect(await rows(ds, sql, [a])).toEqual([]);
  });
});
