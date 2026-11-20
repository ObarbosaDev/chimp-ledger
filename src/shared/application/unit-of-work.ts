import type { WagerTransactionRepository } from '../../wagering/application/wager-transaction.repository';
import type {
  LedgerRepository,
  WalletRepository,
} from '../../wallet/application/wallet.repository';

/**
 * Tudo que precisa ser atômico passa por aqui: os repositórios recebidos
 * dentro de `run` enxergam a mesma transação SQL. Se a função lançar, nada
 * do que ela gravou fica no banco.
 */
export interface TransactionScope {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}
