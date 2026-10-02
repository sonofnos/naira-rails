import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { formatKobo } from '../src/common/money';
import {
  API_KEY,
  GTB,
  GTB_ACCOUNT,
  api,
  createTestApp,
  fundWallet,
  resetState,
  sessionId,
  signedInflow,
  sim,
} from './helpers';

/** Today's business date in Lagos (WAT, UTC+1). */
function lagosToday(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function csv(rows: [string, 'CR' | 'DR', string][]): string {
  const date = lagosToday();
  return [
    'SESSION_ID,TRAN_DATE,DIRECTION,AMOUNT,NARRATION,CHANNEL',
    ...rows.map(([sid, dir, amount]) => `${sid},${date} 12:00:00,${dir},"${amount}",NIP TRANSFER,NIP`),
  ].join('\n');
}

describe('Reconciliation against the settlement statement (real Postgres)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(() => resetState(app));

  const run = (body: { businessDate: string; csv: string }) =>
    api(app).post('/reconciliation/runs').set('x-api-key', API_KEY).send(body);

  it('classifies a realistic day: matched, mismatch, missing either side, duplicate, unresolved payout', async () => {
    const a = await fundWallet(app, 'customer', 'cust_1', '5,000.00');
    const b = await fundWallet(app, 'customer', 'cust_2', '1,200.00');
    const c = await fundWallet(app, 'rider', 'rider_7', '3,000.00');

    // A payout that settles, and one stuck in requery.
    const ok = await api(app)
      .post('/payouts')
      .set('x-api-key', API_KEY)
      .set('idempotency-key', 'recon-payout-1')
      .send({ ownerType: 'rider', ownerId: 'rider_7', amountMinor: 100_000, bankCode: GTB, accountNumber: GTB_ACCOUNT })
      .expect(201);
    sim(app).script(GTB_ACCOUNT, { ft: '96', tsq: Array(10).fill('96') });
    const stuck = await api(app)
      .post('/payouts')
      .set('x-api-key', API_KEY)
      .set('idempotency-key', 'recon-payout-2')
      .send({ ownerType: 'rider', ownerId: 'rider_7', amountMinor: 50_000, bankCode: GTB, accountNumber: GTB_ACCOUNT })
      .expect(201);
    expect(stuck.body.status).toBe('unknown');

    const unknownToUs = sessionId();
    const statement = csv([
      [a.sessionId, 'CR', '5,000.00'], // matched
      [b.sessionId, 'CR', '1,250.00'], // amount mismatch
      [ok.body.sessionId, 'DR', formatKobo(100_000n)], // matched payout
      [stuck.body.sessionId, 'DR', '500.00'], // bank says it left; we're still requerying
      [unknownToUs, 'CR', '42.00'], // missing in ledger
      [a.sessionId, 'CR', '5,000.00'], // duplicate line
      // c.sessionId absent -> missing in statement
    ]);

    const res = await run({ businessDate: lagosToday(), csv: statement }).expect(201);
    expect(res.body.summary).toEqual({
      matched: 2,
      amount_mismatch: 1,
      missing_in_ledger: 2,
      missing_in_statement: 1,
      duplicate_in_statement: 1,
    });
    expect(res.body.businessDate).toBe(lagosToday());
    const byStatus = (s: string) => res.body.items.filter((i: any) => i.status === s);
    expect(byStatus('missing_in_statement')[0].sessionId).toBe(c.sessionId);
    expect(byStatus('amount_mismatch')[0]).toMatchObject({
      sessionId: b.sessionId,
      statementMinor: '125000',
      ledgerMinor: '120000',
    });
    const stuckItem = byStatus('missing_in_ledger').find((i: any) => i.sessionId === stuck.body.sessionId);
    expect(stuckItem.note).toContain('unresolved_payout');

    // Same file again: same run, not a second set of breaks.
    const again = await run({ businessDate: lagosToday(), csv: statement }).expect(200);
    expect(again.body).toMatchObject({ id: res.body.id, replayed: true });
    const [{ n }] = await app.get(DataSource).query(`SELECT count(*)::int AS n FROM recon_runs`);
    expect(n).toBe(1);
  });

  it('a different business day sees none of today’s ledger lines as missing', async () => {
    await signedInflow(app, { sessionId: sessionId(), accountNumber: '9999999999', amount: '10.00' }).expect(200);
    const res = await run({ businessDate: '2020-01-01', csv: csv([]) }).expect(201);
    expect(res.body.summary.missing_in_statement).toBe(0);
  });

  it('rejects a malformed statement with the offending line', async () => {
    const res = await run({
      businessDate: lagosToday(),
      csv: `SESSION_ID,TRAN_DATE,DIRECTION,AMOUNT\n${sessionId()},${lagosToday()} 10:00:00,CR,12.345`,
    }).expect(400);
    expect(res.body.message).toContain('line 2');
  });
});
