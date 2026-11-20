import { type EventContext, IntegrationEvent } from '../../../messaging/domain/integration-event';
import type { WagerTransaction } from '../wager-transaction';
import { snapshotOf, type TransactionSnapshot } from './transaction-snapshot';

/** Qualquer transação aplicada, inclusive LOSS (que não mexe no saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<TransactionSnapshot> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: snapshotOf(tx),
    });
  }
}
