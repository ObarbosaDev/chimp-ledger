import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface PublishableEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export interface PublishOutcome {
  published: string[];
  failed: string[];
}

export interface EventPublisher {
  publish(events: PublishableEvent[]): Promise<PublishOutcome>;
}

const SQS_BATCH_LIMIT = 10;

/**
 * Publica no SQS FIFO de eventos.
 *
 * - MessageGroupId = aggregateId (a carteira): eventos da mesma carteira
 *   saem em ordem, carteiras diferentes não se atrapalham;
 * - MessageDeduplicationId = eventId: se o mesmo evento for publicado de
 *   novo (processo morreu antes de marcar), o SQS descarta dentro da janela
 *   de 5 minutos. Fora dela, quem protege é o consumidor deduplicando por
 *   eventId — a dedup do SQS é otimização, não garantia.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(events: PublishableEvent[]): Promise<PublishOutcome> {
    const outcome: PublishOutcome = { published: [], failed: [] };
    for (let i = 0; i < events.length; i += SQS_BATCH_LIMIT) {
      const chunk = events.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const result = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((event) => ({
              Id: event.id,
              MessageBody: JSON.stringify(event.payload),
              MessageGroupId: event.aggregateId,
              MessageDeduplicationId: event.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: event.eventType },
              },
            })),
          }),
        );
        outcome.published.push(...(result.Successful ?? []).map((s) => s.Id ?? ''));
        outcome.failed.push(...(result.Failed ?? []).map((f) => f.Id ?? ''));
      } catch {
        // Fila fora do ar, credencial errada, rede: o lote inteiro volta
        // para a outbox e tenta de novo com backoff.
        outcome.failed.push(...chunk.map((e) => e.id));
      }
    }
    return outcome;
  }
}
