import type { InboxRepository, OutboxRepository } from '../../messaging/application/message-store';
import type {
  ProviderRepository,
  WagerTransactionRepository,
} from '../../wagering/application/wager-transaction.repository';
import type {
  LedgerRepository,
  WalletRepository,
} from '../../wallet/application/wallet.repository';

/**
 * Tudo que precisa ser atômico passa por aqui: os repositórios recebidos
 * dentro de `run` enxergam a mesma transação SQL. Se a função lançar, nada
 * do que ela gravou fica no banco — nem saldo, nem ledger, nem inbox, nem
 * evento na outbox.
 */
export interface TransactionScope {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  providers: ProviderRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}
