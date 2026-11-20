import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  processedAt?: Date | null;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | null;
  createdAt: Date;
}

const money = { type: 'decimal', precision: 19, scale: 2 } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: money,
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultBalance: { ...money, nullable: true },
    processedAt: { ...timestamp, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { ...timestamp, nullable: true },
    createdAt: timestamp,
  },
});
