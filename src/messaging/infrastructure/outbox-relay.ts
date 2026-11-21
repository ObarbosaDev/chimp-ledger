import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEventEnvelope } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, PublishableEvent } from './event-publisher';

export interface OutboxRelayOptions {
  batchSize: number;
  /** Quanto tempo um lote fica reservado para quem o pegou. */
  leaseMs: number;
}

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurred_at: Date;
  attempts: number;
}

/**
 * Pega eventos da outbox e publica. Foi desenhado para rodar em várias
 * instâncias ao mesmo tempo:
 *
 * 1. reserva um lote com lease (UPDATE ... WHERE id IN (SELECT ... FOR
 *    UPDATE SKIP LOCKED)) numa transação curta — duas instâncias nunca
 *    pegam o mesmo evento, e nenhuma fica parada esperando a outra;
 * 2. publica FORA da transação, sem segurar conexão durante a chamada de rede;
 * 3. marca como publicado ou agenda nova tentativa.
 *
 * Se o processo morrer entre 2 e 3, o lease expira e outra instância
 * publica de novo. Isso gera duplicata, e duplicata é aceitável: o evento
 * carrega eventId e o consumidor descarta repetido. O que não pode é perder.
 */
export class OutboxRelay {
  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions,
  ) {}

  /** Uma rodada. Devolve quantos eventos foram publicados. */
  async runOnce(now: Date): Promise<number> {
    const claimed = await this.claim(now);
    if (claimed.length === 0) return 0;

    const outcome = await this.publisher.publish(claimed.map(toPublishable));
    await this.settle(claimed, outcome.published, now);
    return outcome.published.length;
  }

  private async claim(now: Date): Promise<ClaimedRow[]> {
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
    return this.orm.em.fork().transactional((em) =>
      em.execute<ClaimedRow[]>(
        `update outbox_messages o
            set lease_until = ?
          where o.id in (
                select id
                  from outbox_messages
                 where published_at is null
                   and coalesce(next_attempt_at, occurred_at) <= ?
                   and (lease_until is null or lease_until <= ?)
                 order by occurred_at
                 limit ?
                   for update skip locked)
         returning o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts`,
        [leaseUntil, now, now, this.options.batchSize],
      ),
    );
  }

  private async settle(claimed: ClaimedRow[], publishedIds: string[], now: Date): Promise<void> {
    const published = new Set(publishedIds);
    await this.orm.em.fork().transactional(async (em) => {
      if (published.size > 0) {
        await em.execute(
          // o driver expande o array do `?` em lista: in ('a', 'b', ...)
          'update outbox_messages set published_at = ?, lease_until = null where id in (?)',
          [now, [...published]],
        );
      }
      for (const row of claimed.filter((r) => !published.has(r.id))) {
        // A conta do backoff fica no domínio (OutboxMessage.scheduleRetry).
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: row.occurred_at,
          attempts: row.attempts,
        });
        message.scheduleRetry(now);
        await em.execute(
          'update outbox_messages set attempts = ?, next_attempt_at = ?, lease_until = null where id = ?',
          [message.attempts, message.nextAttemptAt, row.id],
        );
      }
    });
  }
}

function toPublishable(row: ClaimedRow): PublishableEvent {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
  };
}
