import type { MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';

/** Parte comum dos eventos de transação, para os dois não divergirem com o tempo. */
export interface TransactionSnapshot {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  resultBalance?: MoneyProps;
  processedAt?: string;
}

export function snapshotOf(tx: WagerTransaction): TransactionSnapshot {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    resultBalance: tx.resultBalance?.toJSON(),
    processedAt: tx.processedAt?.toISOString(),
  };
}
