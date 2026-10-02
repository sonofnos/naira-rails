import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { detectBrand } from './card-utils';

/**
 * The card processor / acquirer boundary (Paystack, Flutterwave, Interswitch
 * style). The PAN crosses this boundary exactly once, at tokenization, and
 * from then on only the token is used. In production the PAN would go from
 * the client straight to the processor's hosted fields/SDK and this service
 * would never see it at all; accepting it server-side here is what lets the
 * repo prove (with tests) that it is never logged or persisted on the way through.
 */
export const CARD_PROCESSOR = Symbol('CARD_PROCESSOR');

export type ChargeOutcome =
  | { status: 'success'; processorReference: string }
  | { status: 'send_otp'; processorReference: string; message: string }
  | { status: 'declined'; processorReference: string; reason: string };

export interface CardProcessor {
  tokenize(pan: string, expMonth: number, expYear: number, cvv: string): Promise<{ token: string }>;
  charge(token: string, amountMinor: bigint, reference: string): Promise<ChargeOutcome>;
  submitOtp(processorReference: string, otp: string): Promise<{ status: 'success' | 'invalid_otp' | 'declined' }>;
}

/**
 * Deterministic fake processor. Holds the PAN in memory only, as a stand-in
 * for the processor's PCI vault. Rules:
 *  - Verve cards always step up to OTP (valid OTP: 123456)
 *  - PANs ending 0002 are declined ("insufficient funds")
 *  - PANs ending 0036 step up to OTP regardless of brand (3DS-style challenge)
 *  - everything else is approved frictionlessly
 * No real processor, sandbox or card network is involved.
 */
@Injectable()
export class FakeCardProcessor implements CardProcessor {
  private readonly vault = new Map<string, { pan: string }>();
  private readonly pending = new Map<string, string>(); // processorRef -> token

  async tokenize(pan: string): Promise<{ token: string }> {
    const token = `tok_${randomBytes(12).toString('hex')}`;
    this.vault.set(token, { pan });
    return { token };
  }

  async charge(token: string, _amountMinor: bigint, reference: string): Promise<ChargeOutcome> {
    const card = this.vault.get(token);
    const processorReference = `prc_${reference.slice(0, 8)}_${randomBytes(4).toString('hex')}`;
    if (!card) return { status: 'declined', processorReference, reason: 'unknown_token' };
    if (card.pan.endsWith('0002')) return { status: 'declined', processorReference, reason: 'insufficient_funds' };
    if (detectBrand(card.pan) === 'verve' || card.pan.endsWith('0036')) {
      this.pending.set(processorReference, token);
      return { status: 'send_otp', processorReference, message: 'Enter the OTP sent to 080******21' };
    }
    return { status: 'success', processorReference };
  }

  async submitOtp(processorReference: string, otp: string) {
    if (!this.pending.has(processorReference)) return { status: 'declined' as const };
    if (otp !== '123456') return { status: 'invalid_otp' as const };
    this.pending.delete(processorReference);
    return { status: 'success' as const };
  }
}
