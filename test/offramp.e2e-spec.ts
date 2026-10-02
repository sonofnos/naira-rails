import { INestApplication } from '@nestjs/common';
import { SYS } from '../src/ledger/chart-of-accounts';
import { FakeOffRampClient, OFFRAMP_CLIENT } from '../src/offramp/offramp-client';
import { API_KEY, api, createTestApp, expectBooksBalanced, resetState, systemBalance, walletBalance } from './helpers';

const TX = '0x' + 'aB'.repeat(32);
const TX2 = '0x' + 'cd'.repeat(32);

describe('Stablecoin -> NGN off-ramp (fake client, real Postgres)', () => {
  let app: INestApplication;
  let fake: FakeOffRampClient;

  beforeAll(async () => {
    app = await createTestApp();
    fake = app.get<FakeOffRampClient>(OFFRAMP_CLIENT);
  });
  afterAll(() => app.close());
  beforeEach(() => resetState(app));

  const quote = (amountUnits = '25000000') =>
    api(app).post('/offramp/quotes').set('x-api-key', API_KEY).send({ asset: 'USDT', amountUnits }).expect(201);
  const credit = (txHash: string, quoteId: string, network = 'ethereum') =>
    api(app)
      .post('/offramp/credits')
      .set('x-api-key', API_KEY)
      .send({ network, txHash, quoteId, ownerType: 'merchant', ownerId: 'mama_put' });
  const deposit = (txHash: string, confirmations = 20, amountUnits = 25_000_000n) =>
    fake.registerDeposit({
      network: 'ethereum',
      txHash,
      asset: 'USDT',
      amountUnits,
      confirmations,
      toAddress: '0xcustody',
    });

  it('credits NGN at the quoted rate, once, however the tx hash is cased or replayed', async () => {
    deposit(TX);
    const q = await quote();
    const res = await credit(TX, q.body.quoteId).expect(201);
    expect(res.body).toMatchObject({ ngnMinor: '3875000', txHash: TX.toLowerCase() }); // 25 USDT x ₦1,550

    const replays = await Promise.all([
      credit(TX.toUpperCase().replace('0X', '0x'), q.body.quoteId),
      ...Array.from({ length: 9 }, () => credit(TX, q.body.quoteId)),
    ]);
    expect(replays.every((r) => r.status === 200 && r.body.replayed === true)).toBe(true);
    expect(await walletBalance(app, 'merchant', 'mama_put')).toBe(3_875_000n);
    expect(await systemBalance(app, SYS.VIRTUAL_ASSET_CUSTODY)).toBe(3_875_000n);
    await expectBooksBalanced(app);
  });

  it('first-time concurrent credits for one deposit race on the unique constraint and credit once', async () => {
    deposit(TX);
    const q = await quote();
    const results = await Promise.all(Array.from({ length: 10 }, () => credit(TX, q.body.quoteId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(await walletBalance(app, 'merchant', 'mama_put')).toBe(3_875_000n);
  });

  it('refuses under-confirmed deposits, expired quotes, mismatched amounts and quote reuse', async () => {
    deposit(TX, 3);
    const q1 = await quote();
    expect((await credit(TX, q1.body.quoteId).expect(422)).body.error).toBe('insufficient_confirmations');

    deposit(TX, 20);
    fake.expireQuote(q1.body.quoteId);
    expect((await credit(TX, q1.body.quoteId).expect(422)).body.error).toBe('quote_expired');

    const q2 = await quote('10000000');
    expect((await credit(TX, q2.body.quoteId).expect(422)).body.error).toBe('quote_mismatch');

    const q3 = await quote();
    await credit(TX, q3.body.quoteId).expect(201);
    deposit(TX2);
    await credit(TX2, q3.body.quoteId).expect(409); // one quote, one deposit
    await credit('0xdeadbeef', q3.body.quoteId).expect(400);
    expect(await walletBalance(app, 'merchant', 'mama_put')).toBe(3_875_000n);
  });
});
