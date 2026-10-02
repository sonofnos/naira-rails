export const SYS = {
  /** Our pool account at the partner bank (money physically at the bank). */
  SETTLEMENT_BANK: 'SYS:SETTLEMENT_BANK',
  /** Card charges approved but not yet settled by the acquirer (T+1). */
  CARD_RECEIVABLE: 'SYS:CARD_RECEIVABLE',
  /** Stablecoin held in custody, carried at the NGN value it was credited at. */
  VIRTUAL_ASSET_CUSTODY: 'SYS:VIRTUAL_ASSET_CUSTODY',
  /** Wallet money reserved for a NIP payout whose final outcome isn't known yet. */
  TRANSFERS_IN_FLIGHT: 'SYS:TRANSFERS_IN_FLIGHT',
  /** Inflows to an account number we can't attribute — held, never dropped. */
  SUSPENSE: 'SYS:SUSPENSE',
  PLATFORM_REVENUE: 'SYS:PLATFORM_REVENUE',
} as const;

export type SystemAccountCode = (typeof SYS)[keyof typeof SYS];

export const OWNER_TYPES = ['customer', 'merchant', 'rider'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export function walletCode(ownerType: OwnerType, ownerId: string): string {
  return `WALLET:${ownerType.toUpperCase()}:${ownerId}`;
}
