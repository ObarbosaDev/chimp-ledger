import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEventEnvelope } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, PublishableEvent } from './event-publisher';

export interface OutboxRelayOptions {
  /** Quantas carteiras (agregados) cada rodada reivindica. */
  aggregatesPerRound: number;
  /** Quanto tempo os eventos reivindicados ficam reservados para quem os pegou. */
  leaseMs: number;
  /** Ponto de falha injetável, só para testes: roda logo depois de reivindicar os eventos. */
  afterClaim?: () => void;
}

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
 * 2. fora da transação, publico os eventos de cada carteira um por um, na
 *    ordem em que aconteceram. Carteiras diferentes vão em paralelo;
 * 3. na primeira falha de uma carteira eu paro ali: o evento que falhou
 *    ganha nova tentativa com backoff e os seguintes só são liberados, sem
 *    contar tentativa. Assim nenhum evento passa na frente do anterior.
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
    const published: string[] = [];
    for (const [index, event] of events.entries()) {
      const outcome = await this.publisher.publish([toPublishable(event)]);
      if (!outcome.published.includes(event.id)) {
        return {
          published,
          failed: event,
          released: events.slice(index + 1).map((e) => e.id),
        };
      }
      published.push(event.id);
    }
    return { published, released: [] };
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
