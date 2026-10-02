import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { bankByNipCode } from '../banks/nigerian-banks';
import { buildNuban } from '../banks/nuban';
import { one, withTxRetry } from '../common/db';
import { NotFoundError, ValidationError } from '../common/errors';
import { parseNairaToKobo } from '../common/money';
import { OwnerType, SYS } from '../ledger/chart-of-accounts';
import { LedgerService } from '../ledger/ledger.service';
import { isSessionId } from '../nip/session-id';

export interface VirtualAccountRow {
  id: string;
  owner_type: OwnerType;
  owner_id: string;
  account_number: string;
  bank_nip_code: string;
  account_name: string;
  wallet_account_id: string;
}

/** Inbound NIP credit notification as a sponsor bank would push it. */
export interface InflowNotification {
  sessionId: string;
  accountNumber: string;
  /** Naira, decimal string, as banks send it ("2500.00", sometimes "2,500.00"). */
  amount: string;
  originatorAccountName?: string;
  originatorBank?: string;
  narration?: string;
  transactionDate?: string;
}

export interface InflowResult {
  status: 'credited' | 'suspense' | 'duplicate';
  inboundCreditId: string;
}

@Injectable()
export class VirtualAccountsService {
  private readonly logger = new Logger(VirtualAccountsService.name);
  private readonly partnerNipCode: string;
  private readonly partnerCbnCode: string;
  private readonly provider: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    config: ConfigService,
  ) {
    // Virtual accounts are issued under the partner bank's NUBAN range.
    this.partnerNipCode = config.get('VA_PARTNER_NIP_CODE', '000017'); // Wema
    const bank = bankByNipCode(this.partnerNipCode);
    if (!bank?.cbnCode) throw new Error(`VA partner ${this.partnerNipCode} must be a DMB with a CBN code`);
    this.partnerCbnCode = bank.cbnCode;
    this.provider = `bank:${this.partnerNipCode}`;
  }

  /**
   * One dedicated NUBAN per owner, idempotent on (owner_type, owner_id).
   * The serial comes from a Postgres sequence, so two concurrent
   * allocations can never mint the same number; the 10th digit is a real
   * CBN check digit for the partner bank.
   */
  async allocate(ownerType: OwnerType, ownerId: string, displayName: string): Promise<VirtualAccountRow> {
    const existing = await this.findByOwner(ownerType, ownerId);
    if (existing) return existing;

    return withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const walletId = await this.ledger.ensureWallet(ownerType, ownerId, m);
        const seq = await one<{ n: string }>(m, `SELECT nextval('virtual_account_serial') AS n`);
        // 9-digit serial in a dedicated "9xxxxxxxx" block for virtual accounts.
        const accountNumber = buildNuban(this.partnerCbnCode, 900_000_000n + BigInt(seq!.n));
        const row = await one<VirtualAccountRow>(
          m,
          `INSERT INTO virtual_accounts (owner_type, owner_id, account_number, bank_nip_code, account_name, wallet_account_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (owner_type, owner_id) DO NOTHING
           RETURNING *`,
          [ownerType, ownerId, accountNumber, this.partnerNipCode, `SWOOP/${displayName}`.slice(0, 60), walletId],
        );
        // A concurrent allocation for the same owner won; the burned serial is harmless.
        return row ?? (await this.findByOwner(ownerType, ownerId, m))!;
      }),
    );
  }

  /**
   * Credits a virtual account from a (signature-verified) bank notification.
   *
   * Idempotency is the UNIQUE (provider, provider_reference) constraint on
   * inbound_credits, claimed with INSERT ... ON CONFLICT DO NOTHING inside
   * the same transaction as the journal. Banks retry webhooks aggressively
   * (and sometimes deliver the same one twice in parallel); a replay finds
   * the row taken and moves no money.
   *
   * Unknown account numbers are not rejected — the money is already in our
   * pool — they're credited to SUSPENSE for ops to attribute.
   */
  async handleInflow(n: InflowNotification): Promise<InflowResult> {
    if (!isSessionId(n.sessionId)) throw new ValidationError('sessionId must be a 30-digit NIP session ID');
    let amount: bigint;
    try {
      amount = parseNairaToKobo(n.amount);
    } catch (err) {
      throw new ValidationError(err.message);
    }
    if (amount <= 0n) throw new ValidationError('amount must be positive');

    const result = await withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const va = await one<VirtualAccountRow>(
          m,
          `SELECT * FROM virtual_accounts WHERE bank_nip_code = $1 AND account_number = $2`,
          [this.partnerNipCode, n.accountNumber],
        );
        const status = va ? 'credited' : 'suspense';
        const credit = await one<{ id: string }>(
          m,
          `INSERT INTO inbound_credits (provider, provider_reference, account_number, virtual_account_id,
                                        amount_minor, originator_name, originator_bank, narration, status, bank_timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            this.provider,
            n.sessionId,
            n.accountNumber,
            va?.id ?? null,
            amount.toString(),
            n.originatorAccountName ?? null,
            n.originatorBank ?? null,
            n.narration ?? null,
            status,
            n.transactionDate ? new Date(n.transactionDate) : null,
          ],
        );
        if (!credit) return undefined;

        const bank = await this.ledger.systemAccountId(SYS.SETTLEMENT_BANK, m);
        const target = va ? va.wallet_account_id : await this.ledger.systemAccountId(SYS.SUSPENSE, m);
        const posted = await this.ledger.post(
          {
            idempotencyKey: `inflow:${this.provider}:${n.sessionId}`,
            kind: va ? 'va_inflow' : 'va_inflow_suspense',
            reference: n.sessionId,
            lines: [LedgerService.line(bank, 'debit', amount), LedgerService.line(target, 'credit', amount)],
          },
          m,
        );
        await m.query(`UPDATE inbound_credits SET journal_id = $2 WHERE id = $1`, [credit.id, posted.journalId]);
        return { status, inboundCreditId: credit.id } as InflowResult;
      }),
    );

    if (result) return result;
    const prior = await one<{ id: string }>(
      this.dataSource,
      `SELECT id FROM inbound_credits WHERE provider = $1 AND provider_reference = $2`,
      [this.provider, n.sessionId],
    );
    this.logger.log(`duplicate inflow notification for session ${n.sessionId} ignored`);
    return { status: 'duplicate', inboundCreditId: prior!.id };
  }

  async findByOwner(ownerType: OwnerType, ownerId: string, m?: any): Promise<VirtualAccountRow | undefined> {
    return one<VirtualAccountRow>(
      m ?? this.dataSource,
      `SELECT * FROM virtual_accounts WHERE owner_type = $1 AND owner_id = $2`,
      [ownerType, ownerId],
    );
  }

  async getOrThrow(ownerType: OwnerType, ownerId: string) {
    const va = await this.findByOwner(ownerType, ownerId);
    if (!va) throw new NotFoundError('Virtual account');
    return va;
  }
}
