import { type EventContext, IntegrationEvent } from '../../../messaging/domain/integration-event';
import type { WagerTransaction } from '../wager-transaction';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt?: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
        attempts: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt?.toISOString(),
      },
    });
  }
}
