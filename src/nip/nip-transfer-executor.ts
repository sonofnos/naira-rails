import { FundsTransferRequest, NipClient } from './nip-client';
import { RequeryDecision, RequeryPolicy, classifyNipCode, decideAfterStatusQuery } from './nip-response-codes';

export type SendDecision = 'success' | 'failed' | 'unknown';

export interface SendResult {
  decision: SendDecision;
  responseCode: string | null;
  error?: string;
}

export interface RequeryResult {
  decision: RequeryDecision;
  responseCode: string | null;
}

/**
 * The only code path that talks to NIP for transfers. Its contract:
 *
 *   `send` calls fundsTransfer exactly once. It never loops, never retries.
 *   Every outcome that isn't a definitive approval or a definitive decline
 *   (timeouts, transport errors, 01/09/91/94/96/97, unknown codes) is
 *   reported as `unknown`, and the only follow-up is `requery`, which calls
 *   transactionStatusQuery with the SAME session ID.
 *
 * A retry with a fresh session ID after a timeout is a second transfer.
 */
export class NipTransferExecutor {
  constructor(
    private readonly client: NipClient,
    private readonly policy: RequeryPolicy,
  ) {}

  async send(req: FundsTransferRequest): Promise<SendResult> {
    let code: string;
    try {
      ({ responseCode: code } = await this.client.fundsTransfer(req));
    } catch (err) {
      // Timeout, socket reset, 5xx from the sponsor bank: we cannot know
      // whether NIBSS processed it.
      return { decision: 'unknown', responseCode: null, error: String(err?.message ?? err) };
    }
    const outcome = classifyNipCode(code);
    if (outcome === 'success') return { decision: 'success', responseCode: code };
    if (outcome === 'failed') return { decision: 'failed', responseCode: code };
    return { decision: 'unknown', responseCode: code };
  }

  async requery(sessionId: string, msSinceSent: number, requeryCount: number): Promise<RequeryResult> {
    let code: string;
    try {
      ({ responseCode: code } = await this.client.transactionStatusQuery(sessionId));
    } catch {
      const exhausted = requeryCount + 1 >= this.policy.maxRequeries;
      return { decision: exhausted ? 'needs_review' : 'retry_later', responseCode: null };
    }
    return { decision: decideAfterStatusQuery(code, msSinceSent, requeryCount, this.policy), responseCode: code };
  }
}
