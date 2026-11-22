import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from '../../../messaging/infrastructure/persistence/message.repositories';
import {
  MikroOrmProviderRepository,
  MikroOrmWagerTransactionRepository,
} from '../../../wagering/infrastructure/persistence/wager-transaction.repository';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../wallet/infrastructure/persistence/wallet.repository';
import type { RunOptions, TransactionScope, UnitOfWork } from '../../application/unit-of-work';

/**
 * Cada `run` abre um EntityManager novo (fork) e uma transação. O fork é
 * importante: identity map compartilhado entre requisições é receita para
 * ler saldo velho.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  async run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    return this.orm.em.fork().transactional(
      async (em) => {
        // Se a carteira estiver muito disputada, prefiro desistir em poucos
        // segundos (erro transitório, o cliente tenta de novo) a deixar
        // conexões presas esperando o lock indefinidamente.
        await em.execute(`set local lock_timeout = '${Math.trunc(this.lockTimeoutMs)}ms'`);
        return work({
          wallets: new MikroOrmWalletRepository(em),
          ledger: new MikroOrmLedgerRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em),
          providers: new MikroOrmProviderRepository(em),
          inbox: new MikroOrmInboxRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
        });
      },
      options.snapshot
        ? { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true }
        : undefined,
    );
  }
}
