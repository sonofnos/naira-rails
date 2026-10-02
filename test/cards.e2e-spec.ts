import { INestApplication, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SYS } from '../src/ledger/chart-of-accounts';
import { API_KEY, api, createTestApp, expectBooksBalanced, resetState, systemBalance, walletBalance } from './helpers';

const VISA = '4084084084084081';
const VERVE = '5061020000000000094';
const DECLINE = '4000000000000002';

describe('Card pay-ins with OTP step-up (real Postgres)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(() => resetState(app));

  const tokenize = (pan: string, customerId = 'cust_1') =>
    api(app)
      .post('/cards')
      .set('x-api-key', API_KEY)
      .send({ customerId, pan, expMonth: 12, expYear: 2030, cvv: '408' });
  const charge = (cardId: string, amountMinor: number, key = randomUUID()) =>
    api(app)
      .post('/cards/charges')
      .set('x-api-key', API_KEY)
      .set('idempotency-key', key)
      .send({ customerId: 'cust_1', cardId, amountMinor });
  const otp = (chargeId: string, value: string) =>
    api(app).post(`/cards/charges/${chargeId}/otp`).set('x-api-key', API_KEY).send({ otp: value });

  it('frictionless Visa charge credits the wallet against card receivable', async () => {
    const card = await tokenize(VISA).expect(201);
    expect(card.body).toMatchObject({ maskedPan: '408408******4081', brand: 'visa' });
    const c = await charge(card.body.id, 500_000).expect(201);
    expect(c.body.status).toBe('successful');
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(500_000n);
    expect(await systemBalance(app, SYS.CARD_RECEIVABLE)).toBe(500_000n);
    await expectBooksBalanced(app);
  });

  it('Verve steps up to OTP; nothing is credited until the right OTP arrives', async () => {
    const card = await tokenize(VERVE).expect(201);
    expect(card.body.brand).toBe('verve');
    const c = await charge(card.body.id, 300_000).expect(201);
    expect(c.body.status).toBe('pending_otp');
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(0n);

    expect((await otp(c.body.id, '000000').expect(200)).body).toMatchObject({ status: 'pending_otp', otpAttempts: 1 });
    expect((await otp(c.body.id, '123456').expect(200)).body.status).toBe('successful');
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(300_000n);
    await otp(c.body.id, '123456').expect(409); // already complete, no double credit
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(300_000n);
    await expectBooksBalanced(app);
  });

  it('10 parallel OTP guesses consume at most 3 attempts and then the charge fails', async () => {
    const card = await tokenize(VERVE).expect(201);
    const c = await charge(card.body.id, 300_000).expect(201);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => otp(c.body.id, String(100000 + i))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const final = await api(app).get(`/cards/charges/${c.body.id}`).set('x-api-key', API_KEY).expect(200);
    expect(final.body).toMatchObject({ status: 'failed', otpAttempts: 3, failureReason: 'otp_attempts_exceeded' });
    await otp(c.body.id, '123456').expect(409);
    expect(await walletBalance(app, 'customer', 'cust_1')).toBe(0n);
  });

  it('declines move no money; charge replay with the same key returns the original', async () => {
    const card = await tokenize(DECLINE).expect(201);
    const key = randomUUID();
    const first = await charge(card.body.id, 10_000, key).expect(201);
    expect(first.body).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
    const replay = await charge(card.body.id, 10_000, key).expect(200);
    expect(replay.body).toMatchObject({ id: first.body.id, replayed: true });
    await charge(card.body.id, 20_000, key).expect(409);
  });

  it('rejects bad card numbers; re-adding the same card returns the same record', async () => {
    await tokenize('4084084084084082').expect(400);
    const a = await tokenize(VISA).expect(201);
    const b = await tokenize(VISA).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('the PAN and CVV never reach the database, the logs or an error response', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    const spies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
      jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => (capture(s), true)),
    ];
    try {
      const card = await tokenize(VERVE).expect(201);
      await charge(card.body.id, 1_000).expect(201);
      // Validation failure carrying a PAN-like value in the message path.
      const bad = await api(app)
        .post('/cards')
        .set('x-api-key', API_KEY)
        .send({ customerId: 'cust_1', pan: VISA, expMonth: 13, expYear: 2030, cvv: '408' })
        .expect(400);
      expect(JSON.stringify(bad.body)).not.toContain(VISA);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(logged.join('\n')).not.toContain(VERVE);
    expect(logged.some((l) => l.includes('506102*********0094'))).toBe(true); // the tokenization log line, masked

    const ds = app.get(DataSource);
    const tables: { table_name: string }[] = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of tables) {
      const dump: { j: string }[] = await ds.query(`SELECT row_to_json(t)::text AS j FROM "${table_name}" t`);
      const text = dump.map((r) => r.j).join('\n');
      expect(text).not.toContain(VERVE);
      expect(text).not.toContain(VISA);
      expect(text).not.toMatch(/"cvv"/);
    }
  });
});
