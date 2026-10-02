import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { one, withTxRetry } from '../common/db';
import { IdempotencyConflictError, NotFoundError, ValidationError } from '../common/errors';
import { requestHash } from '../common/hash';
import { SYS } from '../ledger/chart-of-accounts';
import { LedgerService, PostingLine } from '../ledger/ledger.service';
import { SplitInput, computeSplit } from './split';

export interface SettleOrderInput extends SplitInput {
  orderId: string;
  customerId: string;
  merchantId: string;
  riderId: string;
}

export interface SettlementRow {
  id: string;
  order_id: string;
  request_hash: string;
  customer_id: string;
  merchant_id: string;
  rider_id: string;
  total_minor: string;
  merchant_minor: string;
  rider_minor: string;
  platform_minor: string;
  journal_id: string;
  created_at: Date;
}

export const settlementView = (s: SettlementRow) => ({
  id: s.id,
  orderId: s.order_id,
  totalMinor: s.total_minor,
  merchantMinor: s.merchant_minor,
  riderMinor: s.rider_minor,
  platformMinor: s.platform_minor,
  journalId: s.journal_id,
});

@Injectable()
export class MarketplaceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Settles a delivered order: one journal debits the customer's wallet for
   * the total and credits merchant, rider and platform. Idempotent on the
   * order id through UNIQUE(order_id) on order_settlements — the order
   * service's "delivered" event can arrive any number of times, in parallel,
   * and splits once.
   */
  async settle(input: SettleOrderInput): Promise<{ settlement: SettlementRow; replayed: boolean }> {
    let split;
    try {
      split = computeSplit(input);
    } catch (err) {
      throw new ValidationError(err.message);
    }
    const hash = requestHash({ ...input });

    const created = await withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const row = await one<SettlementRow>(
          m,
          `INSERT INTO order_settlements (order_id, request_hash, customer_id, merchant_id, rider_id,
                                          total_minor, merchant_minor, rider_minor, platform_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.orderId,
            hash,
            input.customerId,
            input.merchantId,
            input.riderId,
            split.totalMinor.toString(),
            split.merchantMinor.toString(),
            split.riderMinor.toString(),
            split.platformMinor.toString(),
          ],
        );
        if (!row) return undefined;

        const customer = await this.ledger.ensureWallet('customer', input.customerId, m);
        const merchant = await this.ledger.ensureWallet('merchant', input.merchantId, m);
        const rider = await this.ledger.ensureWallet('rider', input.riderId, m);
        const platform = await this.ledger.systemAccountId(SYS.PLATFORM_REVENUE, m);

        const lines: PostingLine[] = [LedgerService.line(customer, 'debit', split.totalMinor)];
        if (split.merchantMinor > 0n) lines.push(LedgerService.line(merchant, 'credit', split.merchantMinor));
        if (split.riderMinor > 0n) lines.push(LedgerService.line(rider, 'credit', split.riderMinor));
        if (split.platformMinor > 0n) lines.push(LedgerService.line(platform, 'credit', split.platformMinor));

        const posted = await this.ledger.post(
          { idempotencyKey: `order:split:${input.orderId}`, kind: 'order_split', reference: input.orderId, lines },
          m,
        );
        return one<SettlementRow>(m, `UPDATE order_settlements SET journal_id = $2 WHERE id = $1 RETURNING *`, [
          row.id,
          posted.journalId,
        ]);
      }),
    );

    if (created) return { settlement: created, replayed: false };
    const prior = await this.get(input.orderId);
    if (!prior) throw new Error('settlement conflict but no row found');
    if (prior.request_hash !== hash) throw new IdempotencyConflictError(`order:${input.orderId}`);
    return { settlement: prior, replayed: true };
  }

  async get(orderId: string) {
    return one<SettlementRow>(this.dataSource, `SELECT * FROM order_settlements WHERE order_id = $1`, [orderId]);
  }

  async getOrThrow(orderId: string) {
    const s = await this.get(orderId);
    if (!s) throw new NotFoundError('Order settlement');
    return s;
  }
}
