import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SYS } from '../src/ledger/chart-of-accounts';
import {
  API_KEY,
  api,
  createTestApp,
  expectBooksBalanced,
  fundWallet,
  resetState,
  systemBalance,
  walletBalance,
} from './helpers';

describe('Marketplace split payout (real Postgres)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetState(app);
    await fundWallet(app, 'customer', 'cust_1', '20000.00');
  });

  const order = {
    customerId: 'cust_1',
    merchantId: 'mama_put',
    riderId: 'rider_7',
    foodSubtotalMinor: 850_000,
    deliveryFeeMinor: 120_000,
    serviceFeeMinor: 30_000,
    commissionBps: 1500,
    riderShareBps: 8000,
  };
  const settle = (orderId: string, body: Record<string, unknown> = order) =>
    api(app).post(`/orders/${orderId}/settlement`).set('x-api-key', API_KEY).send(body);

  it('splits one payment into merchant, rider and platform postings in one journal', async () => {
    const res = await settle('ord_1001').expect(201);
    expect(res.body).toMatchObject({
      totalMinor: '1000000',
      merchantMinor: '722500',
      riderMinor: '96000',
      platformMinor: '181500',
      replayed: false,
    });
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(2_000_000n - 1_000_000n);
    expect(await walletBalance(app, 'merchant', 'mama_put')).toBe(722_500n);
    expect(await walletBalance(app, 'rider', 'rider_7')).toBe(96_000n);
    expect(await systemBalance(app, SYS.PLATFORM_REVENUE)).toBe(181_500n);

    const lines = await app
      .get(DataSource)
      .query(`SELECT direction, amount_minor FROM journal_entries WHERE transaction_id = $1 ORDER BY id`, [
        res.body.journalId,
      ]);
    expect(lines).toHaveLength(4);
    await expectBooksBalanced(app);
  });

  it('the "delivered" event replayed 15 times in parallel splits exactly once', async () => {
    const responses = await Promise.all(Array.from({ length: 15 }, () => settle('ord_1002')));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(14);
    expect(new Set(responses.map((r) => r.body.journalId)).size).toBe(1);
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(1_000_000n);
    expect(await walletBalance(app, 'merchant', 'mama_put')).toBe(722_500n);
    const [{ n }] = await app
      .get(DataSource)
      .query(`SELECT count(*)::int AS n FROM journal_transactions WHERE kind = 'order_split'`);
    expect(n).toBe(1);
    await expectBooksBalanced(app);
  });

  it('a different split for an already-settled order is a 409', async () => {
    await settle('ord_1003').expect(201);
    await settle('ord_1003', { ...order, commissionBps: 1000 }).expect(409);
  });

  it('a customer who cannot cover the order is rejected and no settlement row survives', async () => {
    await settle('ord_1004', { ...order, foodSubtotalMinor: 5_000_000 }).expect(422);
    await api(app).get('/orders/ord_1004/settlement').set('x-api-key', API_KEY).expect(404);
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(2_000_000n);
    await expectBooksBalanced(app);
  });

  it('many different orders from one customer concurrently never overdraw the wallet', async () => {
    // ₦20,000 funds exactly two ₦10,000 orders.
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => settle(`ord_2${i}`)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(responses.filter((r) => r.status === 422)).toHaveLength(4);
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(0n);
    await expectBooksBalanced(app);
  });
});
