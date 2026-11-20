import { describe, expect, test } from 'bun:test';
import {
  InboxMessage,
  InvalidMessageStateError,
} from '../../../src/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message';
import { Money } from '../../../src/shared/domain/money';
import { WalletBalanceChanged } from '../../../src/wagering/domain/events/wallet-balance-changed';
import { Wallet } from '../../../src/wallet/domain/wallet';

const t0 = new Date('2026-11-20T12:00:00.000Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

function sampleEvent() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-open',
    at: t0,
  });
  const entry = wallet.debit({
    entryId: 'entry-1',
    transactionId: 'tx-1',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    at: t0,
  });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt: t0,
  });
}

describe('InboxMessage', () => {
  test('nasce não processada e marca uma única vez', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'h',
      receivedAt: t0,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(t0);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(t0)).toThrow(InvalidMessageStateError);
  });
});

describe('OutboxMessage', () => {
  test('enqueue guarda o envelope serializado do evento', () => {
    const outbox = OutboxMessage.enqueue(sampleEvent());
    expect(outbox.id).toBe('evt-1');
    expect(outbox.eventType).toBe('WalletBalanceChanged');
    expect(outbox.aggregateId).toBe('wallet-1');
    expect(outbox.isPending()).toBe(true);
    expect(outbox.payload.eventType).toBe('WalletBalanceChanged');
  });

  test('está devida assim que entra na fila', () => {
    expect(OutboxMessage.enqueue(sampleEvent()).isDue(t0)).toBe(true);
  });

  test('scheduleRetry cresce exponencialmente com teto de 5 minutos', () => {
    const outbox = OutboxMessage.enqueue(sampleEvent());
    outbox.scheduleRetry(t0);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt).toEqual(plus(1_000));
    expect(outbox.isDue(plus(999))).toBe(false);
    expect(outbox.isDue(plus(1_000))).toBe(true);

    outbox.scheduleRetry(t0);
    expect(outbox.nextAttemptAt).toEqual(plus(2_000));

    for (let i = 0; i < 20; i++) outbox.scheduleRetry(t0);
    expect(outbox.nextAttemptAt).toEqual(plus(300_000));
  });

  test('publicada deixa de estar pendente e não publica duas vezes', () => {
    const outbox = OutboxMessage.enqueue(sampleEvent());
    outbox.markPublished(t0);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(t0)).toBe(false);
    expect(() => outbox.markPublished(t0)).toThrow(InvalidMessageStateError);
  });
});
