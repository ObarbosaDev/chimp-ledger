import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEventEnvelope } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, PublishableEvent } from './event-publisher';

export interface OutboxRelayOptions {
  /** Quantas carteiras (agregados) cada rodada reivindica. */
  aggregatesPerRound: number;
  /** Quanto tempo os eventos reivindicados ficam reservados para quem os pegou. */
  leaseMs: number;
  /** Quantos eventos da mesma carteira vão numa chamada ao SQS (máx. 10). */
  publishBatchSize: number;
  /**
   * Chamado quando eventos de uma carteira foram aceitos depois de um que
   * falhou no mesmo lote, ou seja, saíram na frente dele (ver publishInOrder).
   */
  onOrderAnomaly?: (count: number) => void;
  /** Ponto de falha injetável, só para testes: roda logo depois de reivindicar os eventos. */
  afterClaim?: () => void;
}

const SQS_BATCH_LIMIT = 10;

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurred_at: Date;
  attempts: number;
}

interface AggregateOutcome {
  published: string[];
  failed?: ClaimedRow;
  released: string[];
  /** Eventos aceitos pelo SQS depois de um que falhou no mesmo lote. */
  outOfOrder: number;
}

/**
 * Publica os eventos da outbox mantendo a ordem por carteira, mesmo com
 * várias instâncias rodando ao mesmo tempo.
 *
 * A unidade de trabalho é a carteira (agregado), não o evento:
 *
 * 1. numa transação curta, travo com SKIP LOCKED o evento mais antigo
 *    pendente de cada carteira e reservo (lease) todos os pendentes dela.
 *    Outra instância não consegue pegar a mesma carteira até o lease vencer;
 * 2. fora da transação, publico os eventos de cada carteira em lotes de até
 *    10, na ordem em que aconteceram (numa fila FIFO, o SQS enfileira o lote
 *    na ordem enviada). Carteiras diferentes vão em paralelo;
 * 3. na primeira falha de uma carteira eu paro ali: o evento que falhou
 *    ganha nova tentativa com backoff e os seguintes que não foram enviados
 *    só são liberados, sem contar tentativa.
 *
 * O lote existe porque o custo está em cada chamada ao SQS: medido no
 * LocalStack, um por chamada fica em ~480 msg/s e lotes de 10 passam de
 * 3.000 msg/s. O preço é um caso raro: o SQS recusar só um evento do meio
 * do lote e aceitar os seguintes. Esses seguintes já estão na fila, então
 * contam como publicados, e o caso vira métrica e log (onOrderAnomaly). O
 * consumidor tem o walletVersion de cada evento para reordenar.
 *
 * Se o processo morrer no meio, o lease vence e outra instância retoma a
 * carteira do ponto em que parou. Pode haver republicação do último evento,
 * e isso é aceitável: o consumidor deduplica por eventId.
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
    this.options.afterClaim?.();

    const outcomes = await Promise.all(
      groupByAggregate(claimed).map((events) => this.publishInOrder(events)),
    );
    await this.settle(outcomes, now);
    const outOfOrder = outcomes.reduce((sum, o) => sum + o.outOfOrder, 0);
    if (outOfOrder > 0) this.options.onOrderAnomaly?.(outOfOrder);
    return outcomes.reduce((sum, o) => sum + o.published.length, 0);
  }

  private async claim(now: Date): Promise<ClaimedRow[]> {
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
    const rows = await this.orm.em.fork().transactional((em) =>
      em.execute<ClaimedRow[]>(
        `with heads as (
           select distinct on (aggregate_id) id
             from outbox_messages
            where published_at is null
            order by aggregate_id, occurred_at, id
         ),
         claimable as (
           select o.aggregate_id
             from outbox_messages o
             join heads h on h.id = o.id
            where o.published_at is null
              and coalesce(o.next_attempt_at, o.occurred_at) <= ?
              and (o.lease_until is null or o.lease_until <= ?)
            order by o.occurred_at
            limit ?
              for update of o skip locked
         )
         update outbox_messages m
            set lease_until = ?
          where m.published_at is null
            and m.aggregate_id in (select aggregate_id from claimable)
        returning m.id, m.aggregate_id, m.event_type, m.payload, m.occurred_at, m.attempts`,
        [now, now, this.options.aggregatesPerRound, leaseUntil],
      ),
    );
    // Em SQL cru o driver devolve timestamptz como texto.
    return rows.map((row) => ({ ...row, occurred_at: new Date(row.occurred_at) }));
  }

  private async publishInOrder(events: ClaimedRow[]): Promise<AggregateOutcome> {
    const batchSize = Math.min(Math.max(this.options.publishBatchSize, 1), SQS_BATCH_LIMIT);
    const published: string[] = [];

    for (let start = 0; start < events.length; start += batchSize) {
      const batch = events.slice(start, start + batchSize);
      const accepted = new Set((await this.publisher.publish(batch.map(toPublishable))).published);
      const firstFailure = batch.findIndex((event) => !accepted.has(event.id));

      if (firstFailure === -1) {
        published.push(...batch.map((e) => e.id));
        continue;
      }

      // Tudo o que o SQS aceitou está na fila, inclusive o que veio depois da
      // falha: conta como publicado. O resto do lote e os lotes seguintes
      // nem foram tentados, então só voltam para a fila da outbox.
      const acceptedAfterFailure = batch.slice(firstFailure + 1).filter((e) => accepted.has(e.id));
      published.push(...batch.filter((e) => accepted.has(e.id)).map((e) => e.id));
      return {
        published,
        failed: batch[firstFailure],
        released: [
          ...batch.slice(firstFailure + 1).filter((e) => !accepted.has(e.id)),
          ...events.slice(start + batchSize),
        ].map((e) => e.id),
        outOfOrder: acceptedAfterFailure.length,
      };
    }
    return { published, released: [], outOfOrder: 0 };
  }

  private async settle(outcomes: AggregateOutcome[], now: Date): Promise<void> {
    const published = outcomes.flatMap((o) => o.published);
    const released = outcomes.flatMap((o) => o.released);

    await this.orm.em.fork().transactional(async (em) => {
      // o driver expande o array do `?` em lista: in ('a', 'b', ...)
      if (published.length > 0) {
        await em.execute(
          'update outbox_messages set published_at = ?, lease_until = null where id in (?)',
          [now, published],
        );
      }
      if (released.length > 0) {
        await em.execute('update outbox_messages set lease_until = null where id in (?)', [
          released,
        ]);
      }
      for (const { failed } of outcomes) {
        if (!failed) continue;
        // A conta do backoff fica no domínio (OutboxMessage.scheduleRetry).
        const message = OutboxMessage.rehydrate({
          id: failed.id,
          aggregateId: failed.aggregate_id,
          eventType: failed.event_type,
          payload: failed.payload,
          occurredAt: failed.occurred_at,
          attempts: failed.attempts,
        });
        message.scheduleRetry(now);
        await em.execute(
          'update outbox_messages set attempts = ?, next_attempt_at = ?, lease_until = null where id = ?',
          [message.attempts, message.nextAttemptAt, failed.id],
        );
      }
    });
  }
}

/** Agrupa por carteira, cada grupo na ordem em que os eventos aconteceram. */
function groupByAggregate(rows: ClaimedRow[]): ClaimedRow[][] {
  const sorted = [...rows].sort(
    (a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || a.id.localeCompare(b.id),
  );
  const groups = new Map<string, ClaimedRow[]>();
  for (const row of sorted) {
    groups.set(row.aggregate_id, [...(groups.get(row.aggregate_id) ?? []), row]);
  }
  return [...groups.values()];
}

function toPublishable(row: ClaimedRow): PublishableEvent {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
  };
}
