import type { SubmitWagerResult } from './wager-processor';

export type WagerSource = 'http' | 'sqs' | 'reprocess';

export interface WagerOutcome {
  source: WagerSource;
  kind: string;
  providerId: string;
  walletId: string;
  correlationId: string;
  messageId?: string;
  result: SubmitWagerResult;
  durationMs: number;
}

/**
 * Quem quer saber o desfecho de cada transação (log e métrica). Os casos de
 * uso só avisam; o que fazer com o aviso é decisão da infraestrutura.
 */
export interface WagerObserver {
  transactionHandled(outcome: WagerOutcome): void;
}

export const noopWagerObserver: WagerObserver = { transactionHandled: () => undefined };
