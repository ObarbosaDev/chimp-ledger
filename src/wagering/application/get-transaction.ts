import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { MoneyProps } from '../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { TransactionNotFoundError } from './errors';

export interface TransactionView {
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
  failureCode?: string;
  /** Saldo da carteira no momento em que a transação ficou final. */
  balance?: MoneyProps;
  processedAt?: string;
  createdAt: string;
}

function toTransactionView(t: WagerTransaction): TransactionView {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    status: t.status,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    balance: t.resultBalance?.toJSON(),
    processedAt: t.processedAt?.toISOString(),
    createdAt: t.createdAt.toISOString(),
  };
}

export class GetTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(id: string): Promise<TransactionView> {
    return this.found(await this.uow.run((tx) => tx.transactions.findById(id)), id);
  }

  async byExternalId(providerId: string, externalId: string): Promise<TransactionView> {
    const transaction = await this.uow.run((tx) =>
      tx.transactions.findByExternalId(providerId, externalId),
    );
    return this.found(transaction, `${providerId}/${externalId}`);
  }

  private found(transaction: WagerTransaction | undefined, ref: string): TransactionView {
    if (!transaction) throw new TransactionNotFoundError(`Transação ${ref} não encontrada`);
    return toTransactionView(transaction);
  }
}
