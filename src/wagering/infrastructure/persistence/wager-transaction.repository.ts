import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../application/wager-transaction.repository';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { transactionToRecord } from './wager-transaction.mapper';
import { WagerTransactionSchema } from './wager-transaction.schema';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRecord(transaction));
  }
}
