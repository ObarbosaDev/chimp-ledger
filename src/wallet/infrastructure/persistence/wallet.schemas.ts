import { EntitySchema } from '@mikro-orm/core';

// Formato das linhas como o banco guarda. Valores de dinheiro chegam como
// string ("100.00") porque o driver do Postgres devolve NUMERIC como texto,
// e é exatamente isso que eu quero: nada de passar por number no caminho.

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  ledgerSequence: number;
  ledgerHeadHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  sequence: number;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  prevHash: string;
  entryHash: string;
  createdAt: Date;
}

const money = { type: 'decimal', precision: 19, scale: 2 } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: money,
    version: { type: 'integer' },
    ledgerSequence: { type: 'integer' },
    ledgerHeadHash: { type: 'string', columnType: 'char(64)' },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    sequence: { type: 'integer' },
    direction: { type: 'string' },
    amount: money,
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: money,
    balanceAfter: money,
    prevHash: { type: 'string', columnType: 'char(64)' },
    entryHash: { type: 'string', columnType: 'char(64)' },
    createdAt: timestamp,
  },
});
