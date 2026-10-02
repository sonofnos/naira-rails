/**
 * NIBSS NIP institution codes (6-digit, what NIP name-enquiry / fund-transfer
 * messages carry as DestinationInstitutionCode) alongside the 3-digit CBN
 * bank code used in the NUBAN check-digit algorithm.
 *
 * Deposit money banks carry a 3-digit CBN code; fintech MFBs / PSBs (Kuda,
 * Moniepoint, OPay, PalmPay...) are addressed on NIP by their 6-digit code and
 * use the newer OFI NUBAN scheme, so `cbnCode` is null for them and the
 * service skips the DMB check-digit validation for those destinations.
 *
 * Codes taken from the publicly circulated NIBSS institution list; a real
 * integration would refresh this from the provider's bank-list endpoint.
 */
export interface NigerianBank {
  name: string;
  nipCode: string;
  cbnCode: string | null;
}

export const NIGERIAN_BANKS: readonly NigerianBank[] = [
  { name: 'Sterling Bank', nipCode: '000001', cbnCode: '232' },
  { name: 'Keystone Bank', nipCode: '000002', cbnCode: '082' },
  { name: 'First City Monument Bank', nipCode: '000003', cbnCode: '214' },
  { name: 'United Bank for Africa', nipCode: '000004', cbnCode: '033' },
  { name: 'Jaiz Bank', nipCode: '000006', cbnCode: '301' },
  { name: 'Fidelity Bank', nipCode: '000007', cbnCode: '070' },
  { name: 'Polaris Bank', nipCode: '000008', cbnCode: '076' },
  { name: 'Citibank Nigeria', nipCode: '000009', cbnCode: '023' },
  { name: 'Ecobank Nigeria', nipCode: '000010', cbnCode: '050' },
  { name: 'Unity Bank', nipCode: '000011', cbnCode: '215' },
  { name: 'Stanbic IBTC Bank', nipCode: '000012', cbnCode: '221' },
  { name: 'Guaranty Trust Bank', nipCode: '000013', cbnCode: '058' },
  { name: 'Access Bank', nipCode: '000014', cbnCode: '044' },
  { name: 'Zenith Bank', nipCode: '000015', cbnCode: '057' },
  { name: 'First Bank of Nigeria', nipCode: '000016', cbnCode: '011' },
  { name: 'Wema Bank', nipCode: '000017', cbnCode: '035' },
  { name: 'Union Bank of Nigeria', nipCode: '000018', cbnCode: '032' },
  { name: 'Heritage Bank', nipCode: '000020', cbnCode: '030' },
  { name: 'Standard Chartered Bank', nipCode: '000021', cbnCode: '068' },
  { name: 'Providus Bank', nipCode: '000023', cbnCode: '101' },
  { name: 'Titan Trust Bank', nipCode: '000025', cbnCode: '102' },
  { name: 'Kuda Microfinance Bank', nipCode: '090267', cbnCode: null },
  { name: 'Moniepoint Microfinance Bank', nipCode: '090405', cbnCode: null },
  { name: 'OPay', nipCode: '100004', cbnCode: null },
  { name: 'PalmPay', nipCode: '100033', cbnCode: null },
];

const BY_NIP = new Map(NIGERIAN_BANKS.map((b) => [b.nipCode, b]));

export function bankByNipCode(nipCode: string): NigerianBank | undefined {
  return BY_NIP.get(nipCode);
}
