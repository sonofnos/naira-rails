import { Injectable } from '@nestjs/common';

/**
 * "NIBSS to virtual assets": the integration shape for a stablecoin -> NGN
 * off-ramp. This is an INTERFACE plus a deterministic fake. There is no
 * blockchain node, no custody provider and no exchange behind it in this repo.
 *
 * A real implementation would sit on a custody provider / chain indexer
 * (deposit confirmations) and a liquidity provider (quotes).
 */
export const OFFRAMP_CLIENT = Symbol('OFFRAMP_CLIENT');

export type Network = 'tron' | 'ethereum' | 'bsc' | 'solana';
export type Asset = 'USDT' | 'USDC';

export const ASSET_DECIMALS: Record<Asset, number> = { USDT: 6, USDC: 6 };

/** Confirmations before a deposit is treated as final, per network. */
export const REQUIRED_CONFIRMATIONS: Record<Network, number> = {
  tron: 19,
  ethereum: 12,
  bsc: 15,
  solana: 32,
};

export interface Quote {
  quoteId: string;
  asset: Asset;
  amountUnits: bigint;
  /** Kobo per 1 whole token, integer. */
  rateKoboPerUnit: bigint;
  expiresAt: Date;
}

export interface OnChainDeposit {
  network: Network;
  txHash: string;
  asset: Asset;
  amountUnits: bigint;
  confirmations: number;
  toAddress: string;
}

export interface VirtualAssetOffRampClient {
  createQuote(asset: Asset, amountUnits: bigint): Promise<Quote>;
  getQuote(quoteId: string): Promise<Quote | undefined>;
  getDeposit(network: Network, txHash: string): Promise<OnChainDeposit | undefined>;
}

/**
 * EVM and Tron transaction hashes are hex and case-insensitive: "0xAB.." and
 * "0xab.." are the same transaction. Without normalising, the UNIQUE
 * (network, tx_hash) constraint can be bypassed by changing letter case.
 * Solana signatures are base58 and case-SENSITIVE, so they are left alone.
 */
export function normalizeTxHash(network: Network, txHash: string): string {
  const h = txHash.trim();
  if (network === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h)) throw new Error('invalid solana signature');
    return h;
  }
  const hex = h.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid ${network} tx hash`);
  return network === 'tron' ? hex : `0x${hex}`;
}

/** NGN kobo for `amountUnits` (token base units) at `rateKoboPerUnit`, floored. */
export function convertToKobo(asset: Asset, amountUnits: bigint, rateKoboPerUnit: bigint): bigint {
  return (amountUnits * rateKoboPerUnit) / 10n ** BigInt(ASSET_DECIMALS[asset]);
}

@Injectable()
export class FakeOffRampClient implements VirtualAssetOffRampClient {
  /** ₦1,550.00 per USDT/USDC — a fixed, made-up rate. */
  rateKoboPerUnit = 155_000n;
  quoteTtlMs = 60_000;
  private readonly quotes = new Map<string, Quote>();
  private readonly deposits = new Map<string, OnChainDeposit>();
  private seq = 0;

  async createQuote(asset: Asset, amountUnits: bigint): Promise<Quote> {
    const q: Quote = {
      quoteId: `q_${Date.now().toString(36)}_${++this.seq}`,
      asset,
      amountUnits,
      rateKoboPerUnit: this.rateKoboPerUnit,
      expiresAt: new Date(Date.now() + this.quoteTtlMs),
    };
    this.quotes.set(q.quoteId, q);
    return q;
  }

  async getQuote(quoteId: string) {
    return this.quotes.get(quoteId);
  }

  async getDeposit(network: Network, txHash: string) {
    return this.deposits.get(`${network}:${normalizeTxHash(network, txHash)}`);
  }

  /** Test/demo control: pretend a deposit landed on chain. */
  registerDeposit(d: OnChainDeposit): void {
    this.deposits.set(`${d.network}:${normalizeTxHash(d.network, d.txHash)}`, d);
  }

  expireQuote(quoteId: string): void {
    const q = this.quotes.get(quoteId);
    if (q) q.expiresAt = new Date(0);
  }
}
