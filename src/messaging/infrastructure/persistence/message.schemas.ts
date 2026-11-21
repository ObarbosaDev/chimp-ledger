import { EntitySchema } from '@mikro-orm/core';

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | null;
  leaseUntil?: Date | null;
  publishedAt?: Date | null;
  createdAt?: Date;
}

const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const InboxSchema = new EntitySchema<InboxRecord>({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: timestamp,
    processedAt: { ...timestamp, nullable: true },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: timestamp,
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp, nullable: true },
    leaseUntil: { ...timestamp, nullable: true },
    publishedAt: { ...timestamp, nullable: true },
    createdAt: { ...timestamp, nullable: true },
  },
});
