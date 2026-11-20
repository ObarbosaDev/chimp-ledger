import { InvalidMessageStateError } from './inbox-message';
import type { IntegrationEvent, IntegrationEventEnvelope } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5 * 60_000;

/**
 * Evento esperando para sair. Ele é gravado na mesma transação da mudança
 * de saldo, então nunca existe saldo alterado sem evento (nem o contrário).
 *
 * Não tem limite de tentativas de propósito: desistir aqui significaria
 * perder um evento de algo que já aconteceu. Em vez disso o backoff para
 * em 5 minutos e o lag aparece na métrica da outbox.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<IntegrationEventEnvelope<unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** O id da mensagem é o próprio eventId, que vira a chave de dedup no SQS. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Evento ${this.id} já foi publicado`);
    }
    this._publishedAt = at;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (1s, 2s, 4s... até 5min) */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(BASE_RETRY_MS * 2 ** (this._attempts - 1), MAX_RETRY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
