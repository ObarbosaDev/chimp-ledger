import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository, OutboxRepository } from '../../application/message-store';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import { InboxSchema, OutboxSchema } from './message.schemas';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async record(message: InboxMessage): Promise<boolean> {
    // A inbox nasce já processada: ela é gravada na mesma transação do
    // efeito, então "existe na inbox" e "efeito aplicado" são a mesma coisa.
    const result = await this.em
      .createQueryBuilder(InboxSchema)
      .insert({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.receivedAt,
      })
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxSchema,
      messages.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: m.payload as unknown as Record<string, unknown>,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? null,
      })),
    );
  }
}
