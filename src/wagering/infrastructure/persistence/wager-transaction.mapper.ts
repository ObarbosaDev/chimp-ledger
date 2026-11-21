import { Money } from '../../../shared/domain/money';
import type { FailureCode } from '../../domain/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { WagerTransactionRecord } from './wager-transaction.schema';

export function transactionToRecord(t: WagerTransaction): WagerTransactionRecord {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: t.money.toJSON().amount,
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    correlationId: t.correlationId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    resultBalance: t.resultBalance?.toJSON().amount ?? null,
    processedAt: t.processedAt ?? null,
    referenceAttempts: t.referenceAttempts,
    nextReferenceCheckAt: t.nextReferenceCheckAt ?? null,
    createdAt: t.createdAt,
  };
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  const money = (amount: string) => Money.from({ amount, currency: r.currency });
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    correlationId: r.correlationId ?? undefined,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    status: r.status as WagerTransactionStatus,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    resultBalance: r.resultBalance ? money(r.resultBalance) : undefined,
    processedAt: r.processedAt ?? undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceCheckAt: r.nextReferenceCheckAt ?? undefined,
    createdAt: r.createdAt,
  });
}
