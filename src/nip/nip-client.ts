/**
 * The shape of NIBSS Instant Payment (NIP) as a payment-service integrates
 * with it, either directly or through a sponsor bank / BaaS provider:
 *
 *   NE   name enquiry       -> beneficiary name + NE session (must precede FT)
 *   FT   funds transfer     -> response code, keyed by a 30-digit session ID
 *   TSQ  transaction status -> requery an FT by the SAME session ID
 *
 * Amounts are kobo here; the real NIP XML carries naira with two decimals —
 * that conversion belongs in a concrete adapter, not in business logic.
 *
 * Only `NipSimulatorClient` implements this in this repo. There are no NIBSS
 * or bank credentials behind it.
 */
export const NIP_CLIENT = Symbol('NIP_CLIENT');

export interface NameEnquiryRequest {
  destinationInstitutionCode: string;
  accountNumber: string;
  channelCode: number;
}

export interface NameEnquiryResponse {
  responseCode: string;
  sessionId: string;
  accountNumber: string;
  accountName?: string;
  bankVerificationNumber?: string;
  kycLevel?: number;
}

export interface FundsTransferRequest {
  sessionId: string;
  nameEnquiryRef: string;
  destinationInstitutionCode: string;
  beneficiaryAccountNumber: string;
  beneficiaryAccountName: string;
  originatorAccountName: string;
  narration: string;
  paymentReference: string;
  amountMinor: bigint;
  channelCode: number;
}

export interface FundsTransferResponse {
  responseCode: string;
  sessionId: string;
}

export interface StatusQueryResponse {
  responseCode: string;
  sessionId: string;
}

/** Transport-level failure: request may or may not have reached NIBSS. */
export class NipTimeoutError extends Error {
  constructor(message = 'NIP request timed out') {
    super(message);
    this.name = 'NipTimeoutError';
  }
}

export interface NipClient {
  readonly institutionCode: string;
  nameEnquiry(req: NameEnquiryRequest): Promise<NameEnquiryResponse>;
  fundsTransfer(req: FundsTransferRequest): Promise<FundsTransferResponse>;
  transactionStatusQuery(sessionId: string): Promise<StatusQueryResponse>;
}
