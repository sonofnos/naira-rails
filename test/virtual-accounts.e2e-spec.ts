import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isValidNuban } from '../src/banks/nuban';
import { SYS } from '../src/ledger/chart-of-accounts';
import {
  API_KEY,
  api,
  createTestApp,
  expectBooksBalanced,
  resetState,
  sessionId,
  signedInflow,
  systemBalance,
  walletBalance,
} from './helpers';

describe('Virtual-account pay-ins (real Postgres)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(() => resetState(app));

  const allocate = (ownerId: string, ownerType = 'customer') =>
    api(app).post('/virtual-accounts').set('x-api-key', API_KEY).send({ ownerType, ownerId, displayName: ownerId });

  it('allocates one valid Wema NUBAN per owner, even under concurrent requests', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => allocate('cust_1')));
    const numbers = new Set(responses.map((r) => r.body.accountNumber));
    expect(numbers.size).toBe(1);
    const [accountNumber] = [...numbers];
    expect(isValidNuban('035', accountNumber)).toBe(true);
    expect(responses[0].body.bankNipCode).toBe('000017');

    const other = await allocate('cust_2').expect(201);
    expect(other.body.accountNumber).not.toBe(accountNumber);
    expect(isValidNuban('035', other.body.accountNumber)).toBe(true);
  });

  it('rejects unsigned or tampered webhooks', async () => {
    const va = await allocate('cust_1').expect(201);
    const body = { sessionId: sessionId(), accountNumber: va.body.accountNumber, amount: '1000.00' };
    await api(app).post('/webhooks/bank/inflow').send(body).expect(401);

    const raw = JSON.stringify(body);
    const tampered = raw.replace('1000.00', '9000.00');
    const { signWebhook } = await import('../src/virtual-accounts/webhook-signature');
    await api(app)
      .post('/webhooks/bank/inflow')
      .set('content-type', 'application/json')
      .set('x-bank-signature', signWebhook(raw, 'test-webhook-secret'))
      .send(tampered)
      .expect(401);
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(0n);
  });

  it('credits the wallet once when the bank delivers the same notification 25 times in parallel', async () => {
    const va = await allocate('cust_1').expect(201);
    const body = {
      sessionId: sessionId(),
      accountNumber: va.body.accountNumber,
      amount: '2,500.50',
      originatorAccountName: 'ADA OKAFOR',
      originatorBank: 'GTBank',
    };

    const responses = await Promise.all(Array.from({ length: 25 }, () => signedInflow(app, body)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const statuses = responses.map((r) => r.body.status);
    expect(statuses.filter((s) => s === 'credited')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(24);
    expect(new Set(responses.map((r) => r.body.inboundCreditId)).size).toBe(1);

    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(250_050n);
    expect(await systemBalance(app, SYS.SETTLEMENT_BANK)).toBe(250_050n);
    const [{ n }] = await app.get(DataSource).query(`SELECT count(*)::int AS n FROM journal_transactions`);
    expect(n).toBe(1);
    await expectBooksBalanced(app);
  });

  it('parks money sent to an unknown account number in SUSPENSE instead of dropping it', async () => {
    const res = await signedInflow(app, { sessionId: sessionId(), accountNumber: '9999999999', amount: '700' }).expect(
      200,
    );
    expect(res.body.status).toBe('suspense');
    expect(await systemBalance(app, SYS.SUSPENSE)).toBe(70_000n);
    await expectBooksBalanced(app);
  });

  it('rejects malformed amounts and session IDs without moving money', async () => {
    const va = await allocate('cust_1').expect(201);
    await signedInflow(app, { sessionId: '123', accountNumber: va.body.accountNumber, amount: '10.00' }).expect(400);
    await signedInflow(app, { sessionId: sessionId(), accountNumber: va.body.accountNumber, amount: '10.001' }).expect(
      400,
    );
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(0n);
  });
});
