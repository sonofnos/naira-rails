import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import { DataSource } from 'typeorm';
import { one, rows, withTxRetry } from '../common/db';
import { IdempotencyConflictError, InvalidStateError, NotFoundError, ValidationError } from '../common/errors';
import { requestHash } from '../common/hash';
import { maskPan } from '../common/redact';
import { SYS } from '../ledger/chart-of-accounts';
import { LedgerService } from '../ledger/ledger.service';
import { CARD_PROCESSOR, CardProcessor } from './card-processor';
import { detectBrand, isExpired, isLuhnValid } from './card-utils';

export const MAX_OTP_ATTEMPTS = 3;

interface CardRow {
  id: string;
  customer_id: string;
  token: string;
  bin: string;
  last4: string;
  brand: string;
  exp_month: number;
  exp_year: number;
}

export interface ChargeRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  card_id: string;
  customer_id: string;
  amount_minor: string;
  status: 'initiated' | 'pending_otp' | 'successful' | 'failed';
  processor_reference: string | null;
  otp_attempts: number;
  failure_reason: string | null;
  journal_id: string | null;
}

export const cardView = (c: CardRow) => ({
  id: c.id,
  customerId: c.customer_id,
  maskedPan: `${c.bin}******${c.last4}`,
  brand: c.brand,
  expMonth: c.exp_month,
  expYear: c.exp_year,
});

export const chargeView = (c: ChargeRow) => ({
  id: c.id,
  cardId: c.card_id,
  customerId: c.customer_id,
  amountMinor: c.amount_minor,
  status: c.status,
  otpAttempts: c.otp_attempts,
  failureReason: c.failure_reason,
});

/**
 * Card pay-ins (wallet top-up by card).
 *
 *   tokenize -> processor vault holds the PAN; we keep token, BIN, last4,
 *               brand, expiry and a keyed fingerprint. Never PAN or CVV.
 *   charge   -> success: credit wallet now (DR CARD_RECEIVABLE, CR wallet)
 *               send_otp: charge waits in pending_otp for the customer's OTP
 *   otp      -> at most 3 attempts; each attempt is counted with a CAS before
 *               the processor is called, so parallel guesses can't exceed it.
 */
@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);
  private readonly fingerprintSecret: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CARD_PROCESSOR) private readonly processor: CardProcessor,
    private readonly ledger: LedgerService,
    config: ConfigService,
  ) {
    this.fingerprintSecret = config.get('CARD_FINGERPRINT_SECRET', 'change-me-too');
  }

  async tokenize(customerId: string, rawPan: string, expMonth: number, expYear: number, cvv: string) {
    const pan = rawPan.replace(/[\s-]/g, '');
    if (!isLuhnValid(pan)) throw new ValidationError('Card number is invalid');
    if (!/^\d{3,4}$/.test(cvv)) throw new ValidationError('CVV is invalid');
    if (expMonth < 1 || expMonth > 12 || isExpired(expMonth, expYear)) {
      throw new ValidationError('Card is expired');
    }
    const fingerprint = createHmac('sha256', this.fingerprintSecret).update(pan).digest('hex');
    const existing = await one<CardRow>(
      this.dataSource,
      `SELECT * FROM cards WHERE customer_id = $1 AND fingerprint = $2`,
      [customerId, fingerprint],
    );
    if (existing) return existing;

    const { token } = await this.processor.tokenize(pan, expMonth, expYear, cvv);
    const row = await one<CardRow>(
      this.dataSource,
      `INSERT INTO cards (customer_id, token, bin, last4, brand, exp_month, exp_year, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (customer_id, fingerprint) DO NOTHING
       RETURNING *`,
      [customerId, token, pan.slice(0, 6), pan.slice(-4), detectBrand(pan), expMonth, expYear % 100, fingerprint],
    );
    this.logger.log(`tokenized card ${maskPan(pan)} for customer ${customerId}`);
    return (
      row ??
      (await one<CardRow>(this.dataSource, `SELECT * FROM cards WHERE customer_id = $1 AND fingerprint = $2`, [
        customerId,
        fingerprint,
      ]))!
    );
  }

  async charge(idempotencyKey: string, customerId: string, cardId: string, amountMinor: bigint) {
    if (amountMinor <= 0n) throw new ValidationError('amountMinor must be positive');
    const card = await one<CardRow>(this.dataSource, `SELECT * FROM cards WHERE id = $1 AND customer_id = $2`, [
      cardId,
      customerId,
    ]);
    if (!card) throw new NotFoundError('Card');
    const hash = requestHash({ customerId, cardId, amountMinor });

    const created = await one<ChargeRow>(
      this.dataSource,
      `INSERT INTO card_charges (idempotency_key, request_hash, card_id, customer_id, amount_minor, status)
       VALUES ($1,$2,$3,$4,$5,'initiated')
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [idempotencyKey, hash, cardId, customerId, amountMinor.toString()],
    );
    if (!created) {
      const prior = await one<ChargeRow>(this.dataSource, `SELECT * FROM card_charges WHERE idempotency_key = $1`, [
        idempotencyKey,
      ]);
      if (prior!.request_hash !== hash) throw new IdempotencyConflictError(idempotencyKey);
      return { charge: prior!, replayed: true };
    }

    const outcome = await this.processor.charge(card.token, amountMinor, created.id);
    if (outcome.status === 'success') {
      await this.complete(created.id, outcome.processorReference, ['initiated']);
    } else if (outcome.status === 'send_otp') {
      await rows(
        this.dataSource,
        `UPDATE card_charges SET status = 'pending_otp', processor_reference = $2, updated_at = now()
          WHERE id = $1 AND status = 'initiated'`,
        [created.id, outcome.processorReference],
      );
    } else {
      await this.fail(created.id, outcome.reason, outcome.processorReference);
    }
    return { charge: (await this.getOrThrow(created.id))!, replayed: false };
  }

  async submitOtp(chargeId: string, otp: string) {
    // Count the attempt before asking the processor.
    const attempt = await one<ChargeRow>(
      this.dataSource,
      `UPDATE card_charges SET otp_attempts = otp_attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'pending_otp' AND otp_attempts < $2
        RETURNING *`,
      [chargeId, MAX_OTP_ATTEMPTS],
    );
    if (!attempt) {
      const c = await this.getOrThrow(chargeId);
      throw new InvalidStateError(`Charge is ${c.status}; OTP not accepted`);
    }
    const r = await this.processor.submitOtp(attempt.processor_reference!, otp);
    if (r.status === 'success') {
      await this.complete(chargeId, attempt.processor_reference!, ['pending_otp']);
    } else if (r.status === 'declined' || attempt.otp_attempts >= MAX_OTP_ATTEMPTS) {
      await this.fail(chargeId, r.status === 'declined' ? 'declined' : 'otp_attempts_exceeded');
    }
    return this.getOrThrow(chargeId);
  }

  private async complete(chargeId: string, processorReference: string, from: ChargeRow['status'][]) {
    await withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const c = await one<ChargeRow>(
          m,
          `UPDATE card_charges SET status = 'successful', processor_reference = $2, updated_at = now()
            WHERE id = $1 AND status = ANY($3::text[])
            RETURNING *`,
          [chargeId, processorReference, from],
        );
        if (!c) return;
        const wallet = await this.ledger.ensureWallet('customer', c.customer_id, m);
        const receivable = await this.ledger.systemAccountId(SYS.CARD_RECEIVABLE, m);
        const amount = BigInt(c.amount_minor);
        const posted = await this.ledger.post(
          {
            idempotencyKey: `card:charge:${c.id}`,
            kind: 'card_pay_in',
            reference: processorReference,
            lines: [LedgerService.line(receivable, 'debit', amount), LedgerService.line(wallet, 'credit', amount)],
          },
          m,
        );
        await m.query(`UPDATE card_charges SET journal_id = $2 WHERE id = $1`, [c.id, posted.journalId]);
      }),
    );
  }

  private async fail(chargeId: string, reason: string, processorReference?: string) {
    await rows(
      this.dataSource,
      `UPDATE card_charges SET status = 'failed', failure_reason = $2,
              processor_reference = COALESCE($3, processor_reference), updated_at = now()
        WHERE id = $1 AND status IN ('initiated','pending_otp')`,
      [chargeId, reason, processorReference ?? null],
    );
  }

  async getOrThrow(chargeId: string): Promise<ChargeRow> {
    const c = await one<ChargeRow>(this.dataSource, `SELECT * FROM card_charges WHERE id = $1`, [chargeId]);
    if (!c) throw new NotFoundError('Card charge');
    return c;
  }
}
