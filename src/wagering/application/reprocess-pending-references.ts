import type { Clock } from '../../shared/application/ports';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { WagerProcessor } from './wager-processor';

export interface ReprocessOptions {
  batchSize: number;
  /** Chamado quando uma pendência falha; a rodada continua com as outras. */
  onError?: (transactionId: string, error: unknown) => void;
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
    private readonly clock: Clock,
    private readonly options: ReprocessOptions,
  ) {}

  /**
   * Uma rodada. `now` decide só o que está vencido; o horário gravado em cada
   * transação vem do relógio na hora em que ela é de fato processada.
   * Devolve quantas transações foram tratadas.
   */
  async runOnce(now: Date): Promise<number> {
    const due = await this.uow.run((tx) =>
      tx.transactions.findDuePendingReferences(now, this.options.batchSize),
    );

    let handled = 0;
    // Uma por vez de propósito: cada uma trava uma carteira, e não quero que
    // o reprocessamento dispute lock com o tráfego normal mais do que o necessário.
    for (const { id, walletId } of due) {
      try {
        if (await this.reprocess(id, walletId, now)) handled++;
      } catch (error) {
        // Uma carteira travada (lock_timeout) ou qualquer erro numa pendência
        // não pode impedir as outras do lote. Ela continua vencida e volta na
        // próxima rodada.
        this.options.onError?.(id, error);
      }
    }
    return handled;
  }

  private reprocess(id: string, walletId: string, dueAt: Date): Promise<boolean> {
    return this.uow.run(async (tx) => {
      const wallet = await tx.wallets.findByIdForUpdate(walletId);
      const pending = await tx.transactions.findById(id);
      const stillDue =
        pending?.status === WagerTransactionStatus.PendingReference &&
        (pending.nextReferenceCheckAt?.getTime() ?? 0) <= dueAt.getTime();
      if (!wallet || !pending || !stillDue) return false;

      // Só agora, com o lock na mão, leio o relógio: é este o instante em que
      // o saldo muda, e os eventos da carteira precisam sair em ordem causal.
      const at = this.clock.now();
      const exhausted = this.policy.isExhausted({
        attempts: pending.referenceAttempts,
        createdAt: pending.createdAt,
        now: at,
      });
      await this.processor.process(
        tx,
        pending,
        wallet,
        {
          correlationId: pending.correlationId ?? pending.idempotencyKey,
          causationId: pending.id,
        },
        at,
        { referenceWaitExhausted: exhausted },
      );
      return true;
    });
  }
}
