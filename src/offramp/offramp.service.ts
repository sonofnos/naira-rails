import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { one, withTxRetry } from '../common/db';
import { InvalidStateError, NotFoundError, UnprocessableError, ValidationError } from '../common/errors';
import { OwnerType, SYS } from '../ledger/chart-of-accounts';
import { LedgerService } from '../ledger/ledger.service';
import {
  Asset,
  Network,
  OFFRAMP_CLIENT,
  REQUIRED_CONFIRMATIONS,
  VirtualAssetOffRampClient,
  convertToKobo,
  normalizeTxHash,
} from './offramp-client';

export interface OffRampCreditRow {
  id: string;
  network: Network;
  tx_hash: string;
  quote_id: string;
  asset: Asset;
  amount_units: string;
  rate_kobo_per_unit: string;
  ngn_minor: string;
  owner_type: OwnerType;
  owner_id: string;
  journal_id: string;
}

export const offRampView = (r: OffRampCreditRow) => ({
  id: r.id,
  network: r.network,
  txHash: r.tx_hash,
  quoteId: r.quote_id,
  asset: r.asset,
  amountUnits: r.amount_units,
  rateKoboPerUnit: r.rate_kobo_per_unit,
  ngnMinor: r.ngn_minor,
  ownerType: r.owner_type,
  ownerId: r.owner_id,
});

@Injectable()
export class OffRampService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OFFRAMP_CLIENT) private readonly client: VirtualAssetOffRampClient,
    private readonly ledger: LedgerService,
  ) {}

  createQuote(asset: Asset, amountUnits: bigint) {
    if (amountUnits <= 0n) throw new ValidationError('amountUnits must be positive');
    return this.client.createQuote(asset, amountUnits);
  }

  /**
   * Credits NGN for a confirmed stablecoin deposit at a previously issued
   * quote. Idempotent on (network, normalised tx hash) — UNIQUE constraint —
   * and a quote can back only one credit (UNIQUE quote_id).
   *
   *   DR VIRTUAL_ASSET_CUSTODY (NGN value at quote)   CR owner wallet
   */
  async credit(input: { network: Network; txHash: string; quoteId: string; ownerType: OwnerType; ownerId: string }) {
    let txHash: string;
    try {
      txHash = normalizeTxHash(input.network, input.txHash);
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const prior = await this.find(input.network, txHash);
    if (prior) return { credit: prior, replayed: true };

    const deposit = await this.client.getDeposit(input.network, txHash);
    if (!deposit) throw new NotFoundError('On-chain deposit');
    const needed = REQUIRED_CONFIRMATIONS[input.network];
    if (deposit.confirmations < needed) {
      throw new UnprocessableError(
        `Deposit has ${deposit.confirmations}/${needed} confirmations`,
        'insufficient_confirmations',
      );
    }
    const quote = await this.client.getQuote(input.quoteId);
    if (!quote) throw new NotFoundError('Quote');
    if (quote.expiresAt.getTime() <= Date.now()) throw new UnprocessableError('Quote expired', 'quote_expired');
    if (quote.asset !== deposit.asset || quote.amountUnits !== deposit.amountUnits) {
      throw new UnprocessableError('Deposit does not match the quoted asset/amount', 'quote_mismatch');
    }
    const ngn = convertToKobo(quote.asset, quote.amountUnits, quote.rateKoboPerUnit);
    if (ngn <= 0n) throw new UnprocessableError('Deposit too small to credit', 'dust');

    const created = await withTxRetry(() =>
      this.dataSource.transaction(async (m) => {
        const row = await one<OffRampCreditRow>(
          m,
          `INSERT INTO offramp_credits (network, tx_hash, quote_id, asset, amount_units, rate_kobo_per_unit,
                                        ngn_minor, owner_type, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.network,
            txHash,
            quote.quoteId,
            quote.asset,
            quote.amountUnits.toString(),
            quote.rateKoboPerUnit.toString(),
            ngn.toString(),
            input.ownerType,
            input.ownerId,
          ],
        );
        if (!row) return undefined;
        const wallet = await this.ledger.ensureWallet(input.ownerType, input.ownerId, m);
        const custody = await this.ledger.systemAccountId(SYS.VIRTUAL_ASSET_CUSTODY, m);
        const posted = await this.ledger.post(
          {
            idempotencyKey: `offramp:${input.network}:${txHash}`,
            kind: 'offramp_credit',
            reference: txHash,
            lines: [LedgerService.line(custody, 'debit', ngn), LedgerService.line(wallet, 'credit', ngn)],
          },
          m,
        );
        return one<OffRampCreditRow>(m, `UPDATE offramp_credits SET journal_id = $2 WHERE id = $1 RETURNING *`, [
          row.id,
          posted.journalId,
        ]);
      }),
    );
    if (created) return { credit: created, replayed: false };

    const winner = await this.find(input.network, txHash);
    if (winner) return { credit: winner, replayed: true };
    // The conflict was on quote_id: this quote already backed another deposit.
    throw new InvalidStateError('Quote has already been used for another deposit');
  }

  private find(network: Network, txHash: string) {
    return one<OffRampCreditRow>(this.dataSource, `SELECT * FROM offramp_credits WHERE network = $1 AND tx_hash = $2`, [
      network,
      txHash,
    ]);
  }
}
