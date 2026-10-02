import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { buildNuban } from '../src/banks/nuban';
import { LedgerService } from '../src/ledger/ledger.service';
import { OwnerType, SYS } from '../src/ledger/chart-of-accounts';
import { NIP_CLIENT } from '../src/nip/nip-client';
import { NipSimulatorClient } from '../src/nip/nip-simulator.client';
import { REDIS } from '../src/redis/redis.module';
import { signWebhook } from '../src/virtual-accounts/webhook-signature';

export const API_KEY = 'test-api-key';
export const WEBHOOK_SECRET = 'test-webhook-secret';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error', 'warn'] });
  configureApp(app);
  // Listen on an ephemeral port: handing supertest a non-listening server makes
  // every request call server.listen() itself, which under 25 parallel
  // requests piles listeners onto one Server (MaxListenersExceededWarning).
  await app.listen(0);
  return app;
}

export async function resetState(app: INestApplication): Promise<void> {
  const ds = app.get(DataSource);
  await ds.query(`
    TRUNCATE recon_items, recon_runs, offramp_credits, card_charges, cards, order_settlements,
             payouts, inbound_credits, virtual_accounts, journal_entries, journal_transactions CASCADE;
    DELETE FROM ledger_accounts WHERE code NOT LIKE 'SYS:%';
    UPDATE ledger_accounts SET balance_minor = 0;
  `);
  await app.get<Redis>(REDIS).flushdb();
  sim(app).reset();
}

export const sim = (app: INestApplication) => app.get<NipSimulatorClient>(NIP_CLIENT);
export const api = (app: INestApplication) => request(app.getHttpServer());

let sessionCounter = 0;
/** Unique 30-digit NIP session ID as a remitting bank (GTBank, 000013) would mint it. */
export function sessionId(): string {
  sessionCounter++;
  return (
    '000013' + '261001101500' + String(Date.now() % 1e6).padStart(6, '0') + String(sessionCounter).padStart(6, '0')
  );
}

export function signedInflow(app: INestApplication, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return api(app)
    .post('/webhooks/bank/inflow')
    .set('content-type', 'application/json')
    .set('x-bank-signature', signWebhook(raw, WEBHOOK_SECRET))
    .send(raw);
}

/** Funds a wallet the way production does: a VA allocation plus a signed bank inflow. */
export async function fundWallet(app: INestApplication, ownerType: OwnerType, ownerId: string, naira: string) {
  const va = await api(app)
    .post('/virtual-accounts')
    .set('x-api-key', API_KEY)
    .send({ ownerType, ownerId, displayName: ownerId })
    .expect(201);
  const sid = sessionId();
  await signedInflow(app, { sessionId: sid, accountNumber: va.body.accountNumber, amount: naira }).expect(200);
  return { accountNumber: va.body.accountNumber as string, sessionId: sid };
}

export async function walletBalance(app: INestApplication, ownerType: OwnerType, ownerId: string): Promise<bigint> {
  return app.get(LedgerService).walletBalance(ownerType, ownerId);
}

export async function systemBalance(app: INestApplication, code: (typeof SYS)[keyof typeof SYS]): Promise<bigint> {
  const ledger = app.get(LedgerService);
  return ledger.balanceOf(await ledger.systemAccountId(code));
}

export async function expectBooksBalanced(app: INestApplication): Promise<void> {
  const tb = await app.get(LedgerService).trialBalance();
  expect(tb.accountsWithDrift).toEqual([]);
  expect(tb.debitsMinor).toBe(tb.creditsMinor);
  expect(tb.balanced).toBe(true);
}

export const GTB = '000013';
export const GTB_ACCOUNT = buildNuban('058', 12345678); // seeded in the simulator: ADAEZE NGOZI OKAFOR
