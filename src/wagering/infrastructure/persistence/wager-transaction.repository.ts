import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  PendingReferenceRef,
  ProviderInfo,
  ProviderRepository,
  WagerTransactionRepository,
} from '../../application/wager-transaction.repository';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { ProviderSchema } from './provider.schema';
import { transactionFromRecord, transactionToRecord } from './wager-transaction.mapper';
import { type WagerTransactionRecord, WagerTransactionSchema } from './wager-transaction.schema';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRecord(transaction));
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    // ON CONFLICT DO NOTHING sem alvo cobre as duas chaves únicas de uma vez:
    // (provider, chave de idempotência) e (provider, id externo).
    const result = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert(transactionToRecord(transaction))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async update(t: WagerTransaction): Promise<void> {
    const r = transactionToRecord(t);
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: t.id },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        resultBalance: r.resultBalance,
        processedAt: r.processedAt,
        referenceAttempts: r.referenceAttempts,
        nextReferenceCheckAt: r.nextReferenceCheckAt,
      },
    );
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey: key });
  }

  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId: externalId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async isSettled(betTransactionId: string): Promise<boolean> {
    const [row] = await this.em.execute<{ settled: boolean }[]>(
      `select exists (
         select 1
           from wager_transactions s
          where s.reference_transaction_id = ?
            and s.status = 'PROCESSED'
            and s.kind in ('WIN', 'LOSS')
            and not exists (
                  select 1
                    from wager_transactions r
                   where r.reference_transaction_id = s.id
                     and r.status = 'PROCESSED'
                     and r.kind = 'ROLLBACK')
       ) as settled`,
      [betTransactionId],
    );
    return row?.settled === true;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]> {
    const rows = await this.em.find(
      WagerTransactionSchema,
      { status: 'PENDING_REFERENCE', nextReferenceCheckAt: { $lte: now } },
      {
        fields: ['id', 'walletId'],
        orderBy: { nextReferenceCheckAt: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  // Leitura sempre fresca: o identity map desta transação pode ter uma
  // versão antiga da linha que outra transação acabou de terminar.
  private async findOne(where: Partial<WagerTransactionRecord>) {
    const record = await this.em.findOne(WagerTransactionSchema, where, {
      disableIdentityMap: true,
    });
    return record ? transactionFromRecord(record) : undefined;
  }
}

export class MikroOrmProviderRepository implements ProviderRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<ProviderInfo | undefined> {
    const record = await this.em.findOne(ProviderSchema, { id }, { disableIdentityMap: true });
    return record
      ? { id: record.id, active: record.active, currencies: record.currencies.map((c) => c.trim()) }
      : undefined;
  }
}
