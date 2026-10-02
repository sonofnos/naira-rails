import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SYS } from '../src/ledger/chart-of-accounts';
import { PayoutsService } from '../src/payouts/payouts.service';
import {
  API_KEY,
  GTB,
  GTB_ACCOUNT,
  api,
  createTestApp,
  expectBooksBalanced,
  fundWallet,
  resetState,
  sim,
  systemBalance,
  walletBalance,
} from './helpers';

describe('NIP payouts: requery, never retry (real Postgres + Redis)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });
  afterAll(() => app.close());
  beforeEach(() => resetState(app));

  const payout = (key: string, amountMinor = 250_000, extra: Record<string, unknown> = {}) =>
    api(app)
      .post('/payouts')
      .set('x-api-key', API_KEY)
      .set('idempotency-key', key)
      .send({
        ownerType: 'rider',
        ownerId: 'rider_7',
        amountMinor,
        bankCode: GTB,
        accountNumber: GTB_ACCOUNT,
        ...extra,
      });

  const journalKinds = async () =>
    (await ds.query(`SELECT kind FROM journal_transactions ORDER BY created_at`)).map((r: any) => r.kind);

  beforeEach(async () => {
    await fundWallet(app, 'rider', 'rider_7', '10000.00');
  });

  it('happy path: reserve, send once, settle; wallet and pool both drop', async () => {
    const res = await payout('payout-key-0001').expect(201);
    expect(res.body).toMatchObject({
      status: 'successful',
      lastResponseCode: '00',
      accountName: 'ADAEZE NGOZI OKAFOR',
    });
    expect(res.body.sessionId).toMatch(/^999240\d{24}$/);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(1_000_000n - 250_000n);
    expect(await systemBalance(app, SYS.TRANSFERS_IN_FLIGHT)).toBe(0n);
    expect(await systemBalance(app, SYS.SETTLEMENT_BANK)).toBe(750_000n);
    expect(sim(app).calls.fundsTransfer).toBe(1);
    await expectBooksBalanced(app);
  });

  it('TIMEOUT AFTER NIBSS CREDITED THE RIDER: requeried to success, never re-sent, never refunded', async () => {
    sim(app).script(GTB_ACCOUNT, { ft: 'timeout_after_commit' });
    const res = await payout('payout-key-0002').expect(201);

    expect(res.body.status).toBe('successful');
    expect(sim(app).calls.fundsTransfer).toBe(1);
    expect(sim(app).calls.statusQuery).toBe(1);
    expect(sim(app).recordedTransfers()).toHaveLength(1);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(750_000n);
    expect(await journalKinds()).toEqual(['va_inflow', 'payout_reserve', 'payout_settle']);
    await expectBooksBalanced(app);
  });

  it('timeout before NIBSS saw it: stays unknown with funds in flight; fails only after the not-found grace window', async () => {
    sim(app).script(GTB_ACCOUNT, { ft: 'timeout_before_commit' });
    const res = await payout('payout-key-0003').expect(201);

    expect(res.body.status).toBe('unknown');
    expect(res.body.lastResponseCode).toBe('25');
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(750_000n); // NOT refunded yet
    expect(await systemBalance(app, SYS.TRANSFERS_IN_FLIGHT)).toBe(250_000n);

    // Ten minutes pass (grace is five).
    await ds.query(`UPDATE payouts SET sent_at = now() - interval '10 minutes' WHERE id = $1`, [res.body.id]);
    await api(app).post('/payouts/requery').set('x-api-key', API_KEY).expect(200);

    const after = await api(app).get(`/payouts/${res.body.id}`).set('x-api-key', API_KEY).expect(200);
    expect(after.body.status).toBe('failed');
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(1_000_000n);
    expect(await systemBalance(app, SYS.TRANSFERS_IN_FLIGHT)).toBe(0n);
    expect(sim(app).calls.fundsTransfer).toBe(1);
    await expectBooksBalanced(app);
  });

  it('"09 in progress" outlives the inline requeries and is settled by the sweeper', async () => {
    sim(app).script(GTB_ACCOUNT, { ft: '09', tsq: ['09', '09'], settlesAs: '00' });
    const res = await payout('payout-key-0004').expect(201);
    expect(res.body.status).toBe('unknown');

    const swept = await app.get(PayoutsService).sweep();
    expect(swept.requeried).toBe(1);
    const after = await app.get(PayoutsService).getOrThrow(res.body.id);
    expect(after.status).toBe('successful');
    expect(sim(app).calls.fundsTransfer).toBe(1);
    await expectBooksBalanced(app);
  });

  it('a permanently ambiguous transfer escalates to needs_review with the money still in flight, then ops resolves it', async () => {
    sim(app).script(GTB_ACCOUNT, { ft: '96', tsq: Array(20).fill('96') });
    const res = await payout('payout-key-0005').expect(201);
    const svc = app.get(PayoutsService);
    for (let i = 0; i < 5; i++) await svc.sweep();

    const stuck = await svc.getOrThrow(res.body.id);
    expect(stuck.status).toBe('needs_review');
    expect(await systemBalance(app, SYS.TRANSFERS_IN_FLIGHT)).toBe(250_000n);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(750_000n);
    expect(sim(app).calls.fundsTransfer).toBe(1);

    await api(app)
      .post(`/payouts/${res.body.id}/resolve`)
      .set('x-api-key', API_KEY)
      .send({ outcome: 'failed', evidence: 'Not on NIBSS settlement report for 2026-10-01' })
      .expect(200);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(1_000_000n);
    await api(app)
      .post(`/payouts/${res.body.id}/resolve`)
      .set('x-api-key', API_KEY)
      .send({ outcome: 'successful', evidence: 'second attempt' })
      .expect(409);
    await expectBooksBalanced(app);
  });

  it('a definitive decline releases the reserve immediately', async () => {
    sim(app).script(GTB_ACCOUNT, { ft: '51' });
    const res = await payout('payout-key-0006').expect(201);
    expect(res.body).toMatchObject({ status: 'failed', lastResponseCode: '51' });
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(1_000_000n);
    await expectBooksBalanced(app);
  });

  it('12 parallel requests with one idempotency key: one payout, one FT, one debit', async () => {
    sim(app).latencyMs = 30;
    const responses = await Promise.all(Array.from({ length: 12 }, () => payout('payout-key-0007')));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(11);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(sim(app).calls.fundsTransfer).toBe(1);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(750_000n);
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM payouts`);
    expect(n).toBe(1);
    await expectBooksBalanced(app);
  });

  it('10 different payouts from one wallet at once: no deadlocks, each reserved exactly once', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => payout(`payout-multi-${i}`, 50_000)));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(responses.every((r) => r.body.status === 'successful')).toBe(true);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(1_000_000n - 500_000n);
    expect(sim(app).calls.fundsTransfer).toBe(10);
    await expectBooksBalanced(app);
  });

  it('crash between commit and send: the stuck pending payout is sent exactly once despite racing recoverers', async () => {
    const svc = app.get(PayoutsService);
    // Simulate the process dying right after the reserve committed, before FT.
    jest.spyOn(svc, 'dispatch').mockResolvedValueOnce(undefined);
    const res = await payout('payout-key-crash').expect(201);
    expect(res.body.status).toBe('pending');
    expect(sim(app).calls.fundsTransfer).toBe(0);

    sim(app).latencyMs = 30;
    await ds.query(`UPDATE payouts SET created_at = now() - interval '5 minutes' WHERE id = $1`, [res.body.id]);
    await Promise.all([
      ...Array.from({ length: 4 }, () => svc.sweep()),
      ...Array.from({ length: 4 }, () => svc.dispatch(res.body.id)),
    ]);

    expect(sim(app).calls.fundsTransfer).toBe(1);
    expect((await svc.getOrThrow(res.body.id)).status).toBe('successful');
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(750_000n);
    await expectBooksBalanced(app);
  });

  it('concurrent sweepers on one unknown payout finalize it exactly once', async () => {
    sim(app).script(GTB_ACCOUNT, { ft: 'timeout_after_commit', tsq: ['01', '01'] });
    const res = await payout('payout-key-0008').expect(201);
    expect(res.body.status).toBe('unknown');

    const svc = app.get(PayoutsService);
    await Promise.all(Array.from({ length: 8 }, () => svc.sweep()));
    // Leases may leave some sweepers with nothing to do; sweep until settled.
    for (let i = 0; i < 3; i++) await svc.sweep();

    expect((await svc.getOrThrow(res.body.id)).status).toBe('successful');
    expect((await journalKinds()).filter((k: string) => k === 'payout_settle')).toHaveLength(1);
    expect(await systemBalance(app, SYS.TRANSFERS_IN_FLIGHT)).toBe(0n);
    expect(sim(app).calls.fundsTransfer).toBe(1);
    await expectBooksBalanced(app);
  });

  it('same key, different body is a 409; insufficient funds is a 422 that leaves no payout behind', async () => {
    await payout('payout-key-0009', 1_000).expect(201);
    await payout('payout-key-0009', 2_000).expect(409);
    await payout('payout-key-0010', 50_000_000).expect(422);
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM payouts`);
    expect(n).toBe(1);
    await expectBooksBalanced(app);
  });

  it('validates NUBAN locally before paying for a name enquiry, and caches successful enquiries in Redis', async () => {
    await payout('payout-key-0011', 1_000, { accountNumber: '0123456789' }).expect(400);
    expect(sim(app).calls.nameEnquiry).toBe(0);

    await payout('payout-key-0012', 1_000).expect(201);
    await payout('payout-key-0013', 1_000).expect(201);
    expect(sim(app).calls.nameEnquiry).toBe(1);

    const resolved = await api(app).get(`/banks/${GTB}/accounts/${GTB_ACCOUNT}`).set('x-api-key', API_KEY).expect(200);
    expect(resolved.body.accountName).toBe('ADA*** NGO** OKA***');
  });

  it('an unknown beneficiary fails name enquiry with 07 and moves nothing', async () => {
    const res = await payout('payout-key-0014', 1_000, { accountNumber: '0000000000', bankCode: '090267' }).expect(422);
    expect(res.body.error).toBe('name_enquiry_failed');
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(1_000_000n);
  });

  it('requires an API key and an idempotency key', async () => {
    await api(app).post('/payouts').send({}).expect(401);
    await api(app).post('/payouts').set('x-api-key', API_KEY).send({}).expect(400);
  });
});
