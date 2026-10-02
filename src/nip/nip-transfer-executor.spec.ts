import { FundsTransferRequest } from './nip-client';
import { classifyNipCode, decideAfterStatusQuery } from './nip-response-codes';
import { NipSimulatorClient } from './nip-simulator.client';
import { NipTransferExecutor } from './nip-transfer-executor';
import { generateSessionId, isSessionId } from './session-id';

const policy = { notFoundGraceMs: 60_000, maxRequeries: 5 };
const BANK = '000013';
const ACCOUNT = '0123456785';

async function prepared(sim: NipSimulatorClient): Promise<FundsTransferRequest> {
  const ne = await sim.nameEnquiry({ destinationInstitutionCode: BANK, accountNumber: ACCOUNT, channelCode: 1 });
  return {
    sessionId: generateSessionId(sim.institutionCode),
    nameEnquiryRef: ne.sessionId,
    destinationInstitutionCode: BANK,
    beneficiaryAccountNumber: ACCOUNT,
    beneficiaryAccountName: ne.accountName!,
    originatorAccountName: 'SWOOP TECHNOLOGIES',
    narration: 'Rider payout',
    paymentReference: 'po_1',
    amountMinor: 250_000n,
    channelCode: 1,
  };
}

describe('NIP response classification', () => {
  it.each([
    ['00', 'success'],
    ['51', 'failed'],
    ['07', 'failed'],
    ['01', 'ambiguous'],
    ['09', 'ambiguous'],
    ['91', 'ambiguous'],
    ['94', 'ambiguous'],
    ['96', 'ambiguous'],
    ['97', 'ambiguous'],
    ['25', 'not_found'],
    ['ZZ', 'ambiguous'],
  ])('%s -> %s', (code, expected) => expect(classifyNipCode(code)).toBe(expected));

  it('TSQ "25 not found" only means failed once the grace window has passed', () => {
    expect(decideAfterStatusQuery('25', 5_000, 0, policy)).toBe('retry_later');
    expect(decideAfterStatusQuery('25', 61_000, 0, policy)).toBe('failed');
  });

  it('never auto-fails an ambiguous transfer: exhausting requeries escalates to review', () => {
    expect(decideAfterStatusQuery('96', 10 * 60_000, 3, policy)).toBe('retry_later');
    expect(decideAfterStatusQuery('96', 10 * 60_000, 4, policy)).toBe('needs_review');
  });
});

describe('NipTransferExecutor: requery, never retry', () => {
  let sim: NipSimulatorClient;
  let executor: NipTransferExecutor;

  beforeEach(() => {
    sim = new NipSimulatorClient();
    executor = new NipTransferExecutor(sim, policy);
  });

  it('generates 30-digit session IDs prefixed with the institution code', () => {
    const id = generateSessionId('999240', new Date('2026-10-01T23:30:00Z'));
    expect(isSessionId(id)).toBe(true);
    // 23:30 UTC is 00:30 the next day in Lagos (WAT, UTC+1)
    expect(id.slice(0, 18)).toBe('999240' + '261002003000');
  });

  it('timeout after NIBSS credited the beneficiary: reports unknown, sends once, requery finds success', async () => {
    sim.script(ACCOUNT, { ft: 'timeout_after_commit' });
    const req = await prepared(sim);

    const sent = await executor.send(req);
    expect(sent.decision).toBe('unknown');
    expect(sent.responseCode).toBeNull();

    const requeried = await executor.requery(req.sessionId, 1_000, 0);
    expect(requeried).toEqual({ decision: 'success', responseCode: '00' });
    expect(sim.calls.fundsTransfer).toBe(1);
    expect(sim.recordedTransfers()).toHaveLength(1);
  });

  it('timeout before NIBSS saw it: TSQ says 25; still not failed until the grace window passes', async () => {
    sim.script(ACCOUNT, { ft: 'timeout_before_commit' });
    const req = await prepared(sim);

    expect((await executor.send(req)).decision).toBe('unknown');
    expect((await executor.requery(req.sessionId, 2_000, 0)).decision).toBe('retry_later');
    expect((await executor.requery(req.sessionId, 120_000, 1)).decision).toBe('failed');
    expect(sim.calls.fundsTransfer).toBe(1);
  });

  it('"09 in progress" is followed through TSQ until it settles', async () => {
    sim.script(ACCOUNT, { ft: '09', tsq: ['09', '01'], settlesAs: '00' });
    const req = await prepared(sim);

    expect((await executor.send(req)).decision).toBe('unknown');
    expect((await executor.requery(req.sessionId, 1_000, 0)).decision).toBe('retry_later');
    expect((await executor.requery(req.sessionId, 2_000, 1)).decision).toBe('retry_later');
    expect((await executor.requery(req.sessionId, 3_000, 2)).decision).toBe('success');
    expect(sim.calls.fundsTransfer).toBe(1);
    expect(sim.calls.statusQuery).toBe(3);
  });

  it('a definitive decline is final immediately, with no requery needed', async () => {
    sim.script(ACCOUNT, { ft: '51' });
    const req = await prepared(sim);
    expect(await executor.send(req)).toEqual({ decision: 'failed', responseCode: '51' });
  });

  it('re-sending the same session ID is answered 94 (duplicate) and treated as unknown, not failed', async () => {
    const req = await prepared(sim);
    expect((await executor.send(req)).decision).toBe('success');
    expect(await executor.send(req)).toEqual({ decision: 'unknown', responseCode: '94' });
    expect(sim.recordedTransfers()).toHaveLength(1);
  });

  it('FT without a matching name enquiry is rejected with 08', async () => {
    const req = await prepared(sim);
    expect(await executor.send({ ...req, beneficiaryAccountName: 'SOMEONE ELSE' })).toEqual({
      decision: 'failed',
      responseCode: '08',
    });
  });
});
