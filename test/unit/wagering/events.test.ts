import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { WagerTransactionPendingReference } from '../../../src/wagering/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/wagering/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/wagering/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/wagering/domain/events/wallet-balance-changed';
import { FailureCode } from '../../../src/wagering/domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction';
import { Wallet } from '../../../src/wallet/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-20T12:00:00.000Z');
const ctx = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: t0 };

function bet(kind = WagerTransactionKind.Bet, ref?: string) {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'h',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId: ref,
    createdAt: t0,
  });
}

describe('eventos de integração', () => {
  test('WalletBalanceChanged leva MoneyProps (string), nunca Money', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'e0',
      at: t0,
    });
    const entry = wallet.debit({
      entryId: 'e1',
      transactionId: 'tx-1',
      money: brl('25.00'),
      at: t0,
    });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: undefined,
      occurredAt: '2026-11-20T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    // Ida e volta por JSON não pode mudar nada: o payload tem que ser estável.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('WagerTransactionProcessed carrega status e saldo resultante', () => {
    const tx = bet();
    tx.markProcessed({ referenceTransactionId: undefined, at: t0, resultBalance: brl('75.00') });
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.data).toMatchObject({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      resultBalance: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const tx = bet();
    tx.reject({ code: FailureCode.InsufficientFunds, at: t0, resultBalance: brl('10.00') });
    const json = WagerTransactionRejected.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('WagerTransactionPendingReference diz o que está esperando e até quando', () => {
    const tx = bet(WagerTransactionKind.Refund, 'ext-bet');
    tx.markPendingReference(new Date(t0.getTime() + 2_000));
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.data).toMatchObject({
      transactionId: 'tx-1',
      referenceExternalTransactionId: 'ext-bet',
      attempts: 1,
      nextCheckAt: '2026-11-20T12:00:02.000Z',
    });
  });

  test('eventType e version vêm da classe, não do call site', () => {
    const tx = bet();
    tx.markProcessed({ referenceTransactionId: undefined, at: t0, resultBalance: brl('75.00') });
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
  });
});
