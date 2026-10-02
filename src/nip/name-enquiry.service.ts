import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { bankByNipCode } from '../banks/nigerian-banks';
import { isValidNuban } from '../banks/nuban';
import { UnprocessableError, ValidationError } from '../common/errors';
import { REDIS } from '../redis/redis.module';
import { NIP_CLIENT, NipClient } from './nip-client';
import { NIP_CODES } from './nip-response-codes';

export interface ResolvedAccount {
  bankNipCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  nameEnquiryRef: string;
}

const CACHE_TTL_SECONDS = 600;

/**
 * Masks a beneficiary name for display: first three letters of each word.
 * "ADAEZE NGOZI OKAFOR" -> "ADA*** NGO** OKA***"
 */
export function maskAccountName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w : w.slice(0, 3) + '*'.repeat(w.length - 3)))
    .join(' ');
}

@Injectable()
export class NameEnquiryService {
  private readonly logger = new Logger(NameEnquiryService.name);

  constructor(
    @Inject(NIP_CLIENT) private readonly nip: NipClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Validates bank + NUBAN locally before spending a (billable) NIP name enquiry. */
  validateDestination(bankNipCode: string, accountNumber: string) {
    const bank = bankByNipCode(bankNipCode);
    if (!bank) throw new ValidationError(`Unknown NIP institution code ${bankNipCode}`);
    if (!/^\d{10}$/.test(accountNumber)) throw new ValidationError('Account number must be 10 digits');
    if (bank.cbnCode && !isValidNuban(bank.cbnCode, accountNumber)) {
      throw new ValidationError(`${accountNumber} is not a valid NUBAN for ${bank.name}`);
    }
    return bank;
  }

  /**
   * NE result is cached in Redis for 10 minutes. The NE session ID is part
   * of the cached value because an FT must quote the NE that preceded it.
   */
  async resolve(bankNipCode: string, accountNumber: string): Promise<ResolvedAccount> {
    const bank = this.validateDestination(bankNipCode, accountNumber);
    const key = `nip:ne:${bankNipCode}:${accountNumber}`;
    const cached = await this.redis.get(key).catch((err) => {
      this.logger.warn(`name-enquiry cache read failed: ${err.message}`);
      return null;
    });
    if (cached) return JSON.parse(cached) as ResolvedAccount;

    const res = await this.nip.nameEnquiry({
      destinationInstitutionCode: bankNipCode,
      accountNumber,
      channelCode: 1,
    });
    if (res.responseCode !== '00' || !res.accountName) {
      throw new UnprocessableError(
        `Name enquiry failed: ${res.responseCode} ${NIP_CODES[res.responseCode] ?? ''}`.trim(),
        'name_enquiry_failed',
      );
    }
    const resolved: ResolvedAccount = {
      bankNipCode,
      bankName: bank.name,
      accountNumber,
      accountName: res.accountName,
      nameEnquiryRef: res.sessionId,
    };
    await this.redis.set(key, JSON.stringify(resolved), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return resolved;
  }
}
