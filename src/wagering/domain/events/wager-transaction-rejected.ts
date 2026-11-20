import { type EventContext, IntegrationEvent } from '../../../messaging/domain/integration-event';
import type { WagerTransaction } from '../wager-transaction';
import { snapshotOf, type TransactionSnapshot } from './transaction-snapshot';

export interface WagerTransactionRejectedData extends TransactionSnapshot {
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...snapshotOf(tx), failureCode: tx.failureCode ?? 'UNKNOWN' },
    });
  }
}
