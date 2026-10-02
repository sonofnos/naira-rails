import { Injectable } from '@nestjs/common';
import {
  FundsTransferRequest,
  FundsTransferResponse,
  NameEnquiryRequest,
  NameEnquiryResponse,
  NipClient,
  NipTimeoutError,
  StatusQueryResponse,
} from './nip-client';
import { classifyNipCode } from './nip-response-codes';
import { generateSessionId } from './session-id';

/**
 * In-process stand-in for NIBSS NIP (via a sponsor bank). It is NOT a NIBSS
 * integration — there are no NIBSS credentials anywhere in this repo — but it
 * keeps the parts of NIP's contract that shape correct client code:
 *
 * - FT must reference a prior NE session for the same account and name.
 * - A session ID is accepted once; a second FT with it gets '94'.
 * - TSQ answers from what NIBSS actually recorded, not from what the client
 *   was told — so "timed out on our side, credited on theirs" is observable.
 *
 * Behaviour per beneficiary account is scriptable for tests and demos.
 */
export type FtScript =
  /** Normal approval. */
  | { ft: '00' }
  /** FT answered with `code`; NIBSS's record ends up as `settlesAs` (default: same code, or '00' if ambiguous). */
  | { ft: string; settlesAs?: string; tsq?: string[] }
  /** Processed and credited at NIBSS, but the response never reaches us. The dangerous one. */
  | { ft: 'timeout_after_commit'; tsq?: string[] }
  /** Request lost before NIBSS saw it: nothing recorded. */
  | { ft: 'timeout_before_commit' };

interface RegisteredAccount {
  name: string;
  bvn: string;
  kycLevel: number;
}

interface FtRecord {
  request: FundsTransferRequest;
  finalCode: string;
  tsqQueue: string[];
}

@Injectable()
export class NipSimulatorClient implements NipClient {
  readonly institutionCode: string;
  private readonly accounts = new Map<string, RegisteredAccount>();
  private readonly nameEnquiries = new Map<string, { key: string; name: string }>();
  private readonly transfers = new Map<string, FtRecord>();
  private readonly scripts = new Map<string, FtScript>();
  readonly calls = { nameEnquiry: 0, fundsTransfer: 0, statusQuery: 0 };
  /** Simulated network latency per call, ms. */
  latencyMs = 0;

  constructor(institutionCode = '999240') {
    this.institutionCode = institutionCode;
    this.seed();
  }

  // ---- test/demo controls -------------------------------------------------

  registerAccount(bankCode: string, accountNumber: string, name: string): void {
    this.accounts.set(`${bankCode}:${accountNumber}`, {
      name,
      bvn: '222' + accountNumber.slice(0, 8),
      kycLevel: 3,
    });
  }

  script(accountNumber: string, script: FtScript): void {
    this.scripts.set(accountNumber, script);
  }

  recordedTransfers(): FundsTransferRequest[] {
    return [...this.transfers.values()].map((t) => t.request);
  }

  reset(): void {
    this.nameEnquiries.clear();
    this.transfers.clear();
    this.scripts.clear();
    this.calls.nameEnquiry = this.calls.fundsTransfer = this.calls.statusQuery = 0;
    this.latencyMs = 0;
    this.accounts.clear();
    this.seed();
  }

  // ---- NipClient ----------------------------------------------------------

  async nameEnquiry(req: NameEnquiryRequest): Promise<NameEnquiryResponse> {
    this.calls.nameEnquiry++;
    await this.delay();
    const sessionId = generateSessionId(this.institutionCode);
    const account = this.accounts.get(`${req.destinationInstitutionCode}:${req.accountNumber}`);
    if (!account) {
      return { responseCode: '07', sessionId, accountNumber: req.accountNumber };
    }
    this.nameEnquiries.set(sessionId, {
      key: `${req.destinationInstitutionCode}:${req.accountNumber}`,
      name: account.name,
    });
    return {
      responseCode: '00',
      sessionId,
      accountNumber: req.accountNumber,
      accountName: account.name,
      bankVerificationNumber: account.bvn,
      kycLevel: account.kycLevel,
    };
  }

  async fundsTransfer(req: FundsTransferRequest): Promise<FundsTransferResponse> {
    this.calls.fundsTransfer++;
    await this.delay();
    if (this.transfers.has(req.sessionId)) {
      return { responseCode: '94', sessionId: req.sessionId };
    }
    const ne = this.nameEnquiries.get(req.nameEnquiryRef);
    const key = `${req.destinationInstitutionCode}:${req.beneficiaryAccountNumber}`;
    if (!ne || ne.key !== key || ne.name !== req.beneficiaryAccountName) {
      return this.record(req, '08', '08');
    }
    if (req.amountMinor <= 0n) return this.record(req, '13', '13');

    const script = this.scripts.get(req.beneficiaryAccountNumber) ?? { ft: '00' };
    switch (script.ft) {
      case 'timeout_before_commit':
        throw new NipTimeoutError('simulated timeout before NIBSS recorded the transfer');
      case 'timeout_after_commit':
        this.record(req, '00', '00', 'tsq' in script ? script.tsq : undefined);
        throw new NipTimeoutError('simulated timeout after NIBSS credited the beneficiary');
      default: {
        const s = script as { ft: string; settlesAs?: string; tsq?: string[] };
        const settles = s.settlesAs ?? (classifyNipCode(s.ft) === 'ambiguous' ? '00' : s.ft);
        return this.record(req, s.ft, settles, s.tsq);
      }
    }
  }

  async transactionStatusQuery(sessionId: string): Promise<StatusQueryResponse> {
    this.calls.statusQuery++;
    await this.delay();
    const record = this.transfers.get(sessionId);
    if (!record) return { responseCode: '25', sessionId };
    const next = record.tsqQueue.shift();
    return { responseCode: next ?? record.finalCode, sessionId };
  }

  // ---- internals ----------------------------------------------------------

  private record(req: FundsTransferRequest, answer: string, finalCode: string, tsq?: string[]): FundsTransferResponse {
    this.transfers.set(req.sessionId, { request: req, finalCode, tsqQueue: [...(tsq ?? [])] });
    return { responseCode: answer, sessionId: req.sessionId };
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private seed(): void {
    // A few demo beneficiaries so the API can be exercised by hand.
    // (DMB numbers carry valid NUBAN check digits for their bank.)
    this.registerAccount('000013', '0123456785', 'ADAEZE NGOZI OKAFOR');
    this.registerAccount('000014', '0690000032', 'MAMA PUT KITCHEN LTD');
    this.registerAccount('090405', '8012345678', 'TUNDE BAKARE');
  }
}
