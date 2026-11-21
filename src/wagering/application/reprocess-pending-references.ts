import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { WagerProcessor } from './wager-processor';

export interface ReprocessOptions {
  batchSize: number;
}

/**
 * Volta nas transações que chegaram antes da referência (PENDING_REFERENCE)
 * e tenta de novo, com o mesmo WagerProcessor da submissão.
 *
 * Pode rodar em várias instâncias: cada transação é tratada numa transação
 * SQL própria, com a carteira travada, e eu releio o status depois do lock.
 * Se outra instância já resolveu, esta só segue para a próxima.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly policy: ReferenceRetryPolicy,
    private readonly options: ReprocessOptions,
  ) {}

  /** Uma rodada. Devolve quantas transações foram tratadas. */
  async runOnce(now: Date): Promise<number> {
    const due = await this.uow.run((tx) =>
      tx.transactions.findDuePendingReferences(now, this.options.batchSize),
    );

    let handled = 0;
    // Uma por vez de propósito: cada uma trava uma carteira, e não quero que
    // o varredor dispute lock com o tráfego normal mais do que o necessário.
    for (const { id, walletId } of due) {
      if (await this.reprocess(id, walletId, now)) handled++;
    }
    return handled;
  }

  private reprocess(id: string, walletId: string, now: Date): Promise<boolean> {
    return this.uow.run(async (tx) => {
      const wallet = await tx.wallets.findByIdForUpdate(walletId);
      const pending = await tx.transactions.findById(id);
      const stillDue =
        pending?.status === WagerTransactionStatus.PendingReference &&
        (pending.nextReferenceCheckAt?.getTime() ?? 0) <= now.getTime();
      if (!wallet || !pending || !stillDue) return false;

      const exhausted = this.policy.isExhausted({
        attempts: pending.referenceAttempts,
        createdAt: pending.createdAt,
        now,
      });
      await this.processor.process(
        tx,
        pending,
        wallet,
        { correlationId: pending.idempotencyKey, causationId: pending.id },
        now,
        { referenceWaitExhausted: exhausted },
      );
      return true;
    });
  }
}
