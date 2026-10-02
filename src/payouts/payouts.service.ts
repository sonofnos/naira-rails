import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { one, rows, withTxRetry } from '../common/db';
import { IdempotencyConflictError, InvalidStateError, NotFoundError, ValidationError } from '../common/errors';
import { requestHash } from '../common/hash';
import { OwnerType, SYS } from '../ledger/chart-of-accounts';
import { LedgerService } from '../ledger/ledger.service';
import { NameEnquiryService } from '../nip/name-enquiry.service';
import { NIP_CLIENT, NipClient } from '../nip/nip-client';
import { RequeryPolicy } from '../nip/nip-response-codes';
import { NipTransferExecutor } from '../nip/nip-transfer-executor';
import { generateSessionId } from '../nip/session-id';

export type PayoutStatus = 'pending' | 'processing' | 'unknown' | 'successful' | 'failed' | 'needs_review';

export interface PayoutRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  owner_type: OwnerType;
  owner_id: string;
  wallet_account_id: string;
  amount_minor: string;
  bank_nip_code: string;
  account_number: string;
  account_name: string;
  name_enquiry_ref: string;
  narration: string | null;
  session_id: string;
  status: PayoutStatus;
  last_response_code: string | null;
  requery_count: number;
  next_requery_at: Date | null;
  sent_at: Date | null;
  finalized_at: Date | null;
  created_at: Date;
}

export interface CreatePayoutInput {
  idempotencyKey: string;
  ownerType: OwnerType;
  ownerId: string;
  amountMinor: bigint;
  bankNipCode: string;
  accountNumber: string;
  narration?: string;
}

export function payoutView(p: PayoutRow) {
  return {
    id: p.id,
    status: p.status,
    sessionId: p.session_id,
    amountMinor: p.amount_minor,
    ownerType: p.owner_type,
    ownerId: p.owner_id,
    bankNipCode: p.bank_nip_code,
    accountNumber: p.account_number,
    accountName: p.account_name,
    lastResponseCode: p.last_response_code,
    requeryCount: p.requery_count,
    createdAt: p.created_at,
    finalizedAt: p.finalized_at,
  };
}

/**
 * Wallet -> bank account payouts over NIP (merchant settlements, rider
 * earnings, customer withdrawals).
 *
 * Money flow:
 *   create:   DR wallet            CR TRANSFERS_IN_FLIGHT   (reserve)
 *   success:  DR TRANSFERS_IN_FLIGHT CR SETTLEMENT_BANK     (money left the pool)
 *   failed:   DR TRANSFERS_IN_FLIGHT CR wallet              (reserve released)
 *   unknown:  nothing moves — the reserve stays in flight until TSQ answers
 *
 * State machine, every transition a compare-and-set UPDATE:
 *   pending -> processing        (exactly one worker wins; only it calls FT)
 *   processing -> successful | failed | unknown
 *   unknown -> successful | failed | unknown | needs_review   (via TSQ only)
 *   needs_review -> successful | failed                       (operator, with evidence)
 */
@Injectable()
export class PayoutsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly executor: NipTransferExecutor;
  private readonly policy: RequeryPolicy;
  private readonly backoffMs: number;
  private readonly inlineRequeries: number;
  private readonly staleMs: number;
  private sweeper?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(NIP_CLIENT) private readonly nip: NipClient,
    private readonly ledger: LedgerService,
    private readonly names: NameEnquiryService,
    private readonly config: ConfigService,
  ) {
    this.policy = {
      notFoundGraceMs: Number(config.get('NIP_NOT_FOUND_GRACE_MS', 5 * 60_000)),
      maxRequeries: Number(config.get('NIP_MAX_REQUERIES', 10)),
    };
    this.backoffMs = Number(config.get('PAYOUT_REQUERY_BACKOFF_MS', 2_000));
    this.inlineRequeries = Number(config.get('PAYOUT_INLINE_REQUERIES', 2));
    this.staleMs = Number(config.get('PAYOUT_STALE_MS', 60_000));
    this.executor = new NipTransferExecutor(nip, this.policy);
  }

  onModuleInit(): void {
    const every = Number(this.config.get('PAYOUT_SWEEP_INTERVAL_MS', 0));
    if (every > 0) {
      this.sweeper = setInterval(() => {
        this.sweep().catch((err) => this.logger.error(`requery sweep failed: ${err.message}`));
      }, every);
      this.sweeper.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async create(input: CreatePayoutInput): Promise<{ payout: PayoutRow; replayed: boolean }> {
    if (input.amountMinor <= 0n) throw new ValidationError('amountMinor must be positive');
    const hash = requestHash({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      amountMinor: input.amountMinor,
      bankNipCode: input.bankNipCode,
      accountNumber: input.accountNumber,
      narration: input.narration ?? null,
    });

    // Cheap replay path first: don't spend a billable name enquiry on a retry.
    const prior = await this.findByKey(input.idempotencyKey);
    if (prior) return { payout: this.assertSameRequest(prior, hash), replayed: true };

    const resolved = await this.names.resolve(input.bankNipCode, input.accountNumber);
    const sessionId = generateSessionId(this.nip.institutionCode);

    const created = await withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const walletId = await this.ledger.ensureWallet(input.ownerType, input.ownerId, m);
        const inFlight = await this.ledger.systemAccountId(SYS.TRANSFERS_IN_FLIGHT, m);
        // Lock before the INSERT: payouts.wallet_account_id is a FK, and the
        // FK check's KEY SHARE lock followed by post()'s FOR UPDATE deadlocked
        // concurrent payouts from the same wallet.
        await this.ledger.lockAccounts([walletId, inFlight], m);
        const row = await one<PayoutRow>(
          m,
          `INSERT INTO payouts (idempotency_key, request_hash, owner_type, owner_id, wallet_account_id,
                                amount_minor, bank_nip_code, account_number, account_name,
                                name_enquiry_ref, narration, session_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.idempotencyKey,
            hash,
            input.ownerType,
            input.ownerId,
            walletId,
            input.amountMinor.toString(),
            input.bankNipCode,
            input.accountNumber,
            resolved.accountName,
            resolved.nameEnquiryRef,
            input.narration ?? null,
            sessionId,
          ],
        );
        if (!row) return undefined; // lost the race to a concurrent request with the same key
        await this.ledger.post(
          {
            idempotencyKey: `payout:reserve:${row.id}`,
            kind: 'payout_reserve',
            reference: sessionId,
            lines: [
              LedgerService.line(walletId, 'debit', input.amountMinor),
              LedgerService.line(inFlight, 'credit', input.amountMinor),
            ],
          },
          m,
        );
        return row;
      }),
    );

    if (!created) {
      const winner = await this.findByKey(input.idempotencyKey);
      if (!winner) throw new Error('payout insert conflicted but no row found');
      return { payout: this.assertSameRequest(winner, hash), replayed: true };
    }

    await this.dispatch(created.id);
    return { payout: (await this.get(created.id))!, replayed: false };
  }

  /**
   * Sends the FT for a pending payout. The pending -> processing CAS is the
   * at-most-once guarantee: whoever flips it is the only caller of FT for
   * this payout, ever. A crash after the flip leaves it `processing`, which
   * the sweeper treats as unknown (requery), never as unsent.
   */
  async dispatch(id: string): Promise<void> {
    const claimed = await one<PayoutRow>(
      this.dataSource,
      `UPDATE payouts SET status = 'processing', sent_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [id],
    );
    if (!claimed) return;

    const result = await this.executor.send({
      sessionId: claimed.session_id,
      nameEnquiryRef: claimed.name_enquiry_ref,
      destinationInstitutionCode: claimed.bank_nip_code,
      beneficiaryAccountNumber: claimed.account_number,
      beneficiaryAccountName: claimed.account_name,
      originatorAccountName: 'SWOOP MARKETPLACE',
      narration: claimed.narration ?? `Payout ${claimed.id.slice(0, 8)}`,
      paymentReference: claimed.id,
      amountMinor: BigInt(claimed.amount_minor),
      channelCode: 1,
    });

    if (result.decision === 'success' || result.decision === 'failed') {
      await this.finalize(id, result.decision === 'success' ? 'successful' : 'failed', result.responseCode, [
        'processing',
      ]);
      return;
    }

    this.logger.warn(
      `payout ${id} session ${claimed.session_id} outcome unknown (${result.responseCode ?? result.error}); requerying`,
    );
    await rows(
      this.dataSource,
      `UPDATE payouts SET status = 'unknown', last_response_code = $2,
              next_requery_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id, result.responseCode, this.backoffMs],
    );
    for (let i = 0; i < this.inlineRequeries; i++) {
      if (this.backoffMs > 0) await new Promise((r) => setTimeout(r, this.backoffMs));
      const status = await this.requeryOne(id);
      if (status !== 'unknown') return;
    }
  }

  /**
   * One TSQ for a payout whose outcome is unknown. Takes a short lease
   * (next_requery_at pushed forward) so two sweepers don't requery the same
   * payout at once; correctness doesn't depend on it — finalize is a CAS.
   */
  async requeryOne(id: string): Promise<PayoutStatus | undefined> {
    const leased = await one<PayoutRow>(
      this.dataSource,
      `UPDATE payouts SET next_requery_at = now() + interval '30 seconds', updated_at = now()
        WHERE id = $1
          AND (status = 'unknown' OR (status = 'processing' AND sent_at < now() - ($2::int * interval '1 millisecond')))
          AND (next_requery_at IS NULL OR next_requery_at <= now())
        RETURNING *`,
      [id, this.staleMs],
    );
    if (!leased) return (await this.get(id))?.status;

    const msSinceSent = Date.now() - new Date(leased.sent_at ?? leased.created_at).getTime();
    const r = await this.executor.requery(leased.session_id, msSinceSent, leased.requery_count);

    switch (r.decision) {
      case 'success':
      case 'failed':
        await this.finalize(id, r.decision === 'success' ? 'successful' : 'failed', r.responseCode, [
          'unknown',
          'processing',
        ]);
        break;
      case 'needs_review':
        this.logger.error(`payout ${id} still ambiguous after ${leased.requery_count + 1} requeries: needs review`);
        await rows(
          this.dataSource,
          `UPDATE payouts SET status = 'needs_review', last_response_code = $2,
                  requery_count = requery_count + 1, next_requery_at = NULL, updated_at = now()
            WHERE id = $1 AND status IN ('unknown','processing')`,
          [id, r.responseCode],
        );
        break;
      case 'retry_later': {
        const delay = Math.min(this.backoffMs * 2 ** leased.requery_count, 15 * 60_000);
        await rows(
          this.dataSource,
          `UPDATE payouts SET status = 'unknown', last_response_code = $2, requery_count = requery_count + 1,
                  next_requery_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
            WHERE id = $1 AND status IN ('unknown','processing')`,
          [id, r.responseCode, delay],
        );
        break;
      }
    }
    return (await this.get(id))?.status;
  }

  /** Picks up everything that needs attention: due requeries, stale sends, never-sent rows. */
  async sweep(limit = 50): Promise<{ requeried: number; dispatched: number }> {
    const due = await rows<{ id: string; status: PayoutStatus }>(
      this.dataSource,
      `SELECT id, status FROM payouts
        WHERE (status = 'unknown' AND next_requery_at <= now())
           OR (status = 'processing' AND sent_at < now() - ($1::int * interval '1 millisecond'))
           OR (status = 'pending' AND created_at < now() - ($1::int * interval '1 millisecond'))
        ORDER BY next_requery_at NULLS FIRST
        LIMIT $2`,
      [this.staleMs, limit],
    );
    let requeried = 0;
    let dispatched = 0;
    for (const p of due) {
      if (p.status === 'pending') {
        await this.dispatch(p.id);
        dispatched++;
      } else {
        await this.requeryOne(p.id);
        requeried++;
      }
    }
    return { requeried, dispatched };
  }

  /** Operator resolution of a needs_review payout, e.g. from the NIBSS settlement report. */
  async resolveManually(id: string, outcome: 'successful' | 'failed', evidence: string): Promise<PayoutRow> {
    if (!evidence?.trim()) throw new ValidationError('evidence is required');
    const ok = await this.finalize(id, outcome, `MANUAL:${evidence.slice(0, 40)}`, ['needs_review']);
    if (!ok) throw new InvalidStateError('Only needs_review payouts can be resolved manually');
    return (await this.get(id))!;
  }

  /**
   * Terminal transition + its journal, in one transaction. The CAS on status
   * means two concurrent finalizers (inline requery vs sweeper) can't both
   * post; the journal idempotency key is a second, independent guard.
   */
  private async finalize(
    id: string,
    outcome: 'successful' | 'failed',
    code: string | null,
    from: PayoutStatus[],
  ): Promise<boolean> {
    return withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const p = await one<PayoutRow>(
          m,
          `UPDATE payouts SET status = $2, last_response_code = COALESCE($3, last_response_code),
                  finalized_at = now(), next_requery_at = NULL, updated_at = now()
            WHERE id = $1 AND status = ANY($4::text[])
            RETURNING *`,
          [id, outcome, code, from],
        );
        if (!p) return false;
        const inFlight = await this.ledger.systemAccountId(SYS.TRANSFERS_IN_FLIGHT, m);
        const amount = BigInt(p.amount_minor);
        if (outcome === 'successful') {
          const bank = await this.ledger.systemAccountId(SYS.SETTLEMENT_BANK, m);
          await this.ledger.post(
            {
              idempotencyKey: `payout:settle:${p.id}`,
              kind: 'payout_settle',
              reference: p.session_id,
              lines: [LedgerService.line(inFlight, 'debit', amount), LedgerService.line(bank, 'credit', amount)],
            },
            m,
          );
        } else {
          await this.ledger.post(
            {
              idempotencyKey: `payout:reverse:${p.id}`,
              kind: 'payout_reverse',
              reference: p.session_id,
              lines: [
                LedgerService.line(inFlight, 'debit', amount),
                LedgerService.line(p.wallet_account_id, 'credit', amount),
              ],
            },
            m,
          );
        }
        return true;
      }),
    );
  }

  async get(id: string): Promise<PayoutRow | undefined> {
    return one<PayoutRow>(this.dataSource, `SELECT * FROM payouts WHERE id = $1`, [id]);
  }

  async getOrThrow(id: string): Promise<PayoutRow> {
    const p = await this.get(id);
    if (!p) throw new NotFoundError('Payout');
    return p;
  }

  async pendingSessionIds(): Promise<string[]> {
    const r = await rows<{ session_id: string }>(
      this.dataSource,
      `SELECT session_id FROM payouts WHERE status IN ('processing','unknown','needs_review')`,
    );
    return r.map((x) => x.session_id);
  }

  private async findByKey(key: string): Promise<PayoutRow | undefined> {
    return one<PayoutRow>(this.dataSource, `SELECT * FROM payouts WHERE idempotency_key = $1`, [key]);
  }

  private assertSameRequest(p: PayoutRow, hash: string): PayoutRow {
    if (p.request_hash !== hash) throw new IdempotencyConflictError(p.idempotency_key);
    return p;
  }
}
