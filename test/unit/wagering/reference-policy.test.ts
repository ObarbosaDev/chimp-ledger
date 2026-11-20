import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { FailureCode } from '../../../src/wagering/domain/failure-code';
import { evaluateReference } from '../../../src/wagering/domain/reference-policy';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/wagering/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-20T12:00:00.000Z');

function tx(over: Partial<CreateWagerTransactionProps>): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx',
    providerId: 'provider-a',
    externalTransactionId: 'ext',
    idempotencyKey: 'k',
    payloadHash: 'h',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'g',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: t0,
    ...over,
  });
}

function processed(over: Partial<CreateWagerTransactionProps>): WagerTransaction {
  const t = tx(over);
  t.markProcessed({ referenceTransactionId: undefined, at: t0, resultBalance: brl('1.00') });
  return t;
}

const refund = tx({
  id: 'r',
  kind: WagerTransactionKind.Refund,
  referenceExternalTransactionId: 'ext',
});
const rollback = tx({
  id: 'rb',
  kind: WagerTransactionKind.Rollback,
  referenceExternalTransactionId: 'ext',
});

describe('evaluateReference', () => {
  test('referência ausente → aguardar', () => {
    expect(evaluateReference(refund, undefined)).toEqual({ outcome: 'WAIT' });
  });

  test('referência ainda pendente → aguardar', () => {
    expect(evaluateReference(refund, tx({}))).toEqual({ outcome: 'WAIT' });
  });

  test('REFUND de BET processada no mesmo contexto → ok', () => {
    expect(evaluateReference(refund, processed({}))).toEqual({ outcome: 'OK' });
  });

  test('referência rejeitada → REFERENCE_NOT_PROCESSED', () => {
    const rejected = tx({});
    rejected.reject({ code: FailureCode.InsufficientFunds, at: t0, resultBalance: brl('0.00') });
    expect(evaluateReference(refund, rejected)).toEqual({
      outcome: 'REJECT',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test.each([
    ['REFUND de WIN', refund, { kind: WagerTransactionKind.Win }],
    [
      'ROLLBACK de ROLLBACK',
      rollback,
      { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'z' },
    ],
    ['ROLLBACK de LOSS', rollback, { kind: WagerTransactionKind.Loss }],
  ] as const)('%s → INVALID_REFERENCE_KIND', (_n, reversal, refOver) => {
    expect(evaluateReference(reversal, processed(refOver))).toEqual({
      outcome: 'REJECT',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test.each([
    ['outro provedor', { providerId: 'provider-b' }],
    ['outro jogador', { playerId: 'player-2' }],
    ['outra carteira', { walletId: 'wallet-2' }],
    ['outra rodada', { roundId: 'round-2' }],
  ])('referência de %s → REFERENCE_MISMATCH', (_n, over) => {
    expect(evaluateReference(refund, processed(over))).toEqual({
      outcome: 'REJECT',
      code: FailureCode.ReferenceMismatch,
    });
  });

  test('referência em outra moeda → CURRENCY_MISMATCH', () => {
    expect(
      evaluateReference(
        refund,
        processed({ money: Money.from({ amount: '25.00', currency: 'USD' }) }),
      ),
    ).toEqual({ outcome: 'REJECT', code: FailureCode.CurrencyMismatch });
  });

  test('valor diferente da referência → AMOUNT_MISMATCH (reversão parcial fora do escopo)', () => {
    expect(evaluateReference(refund, processed({ money: brl('24.99') }))).toEqual({
      outcome: 'REJECT',
      code: FailureCode.AmountMismatch,
    });
  });

  test('WIN pode referenciar BET com valor diferente (prêmio ≠ aposta)', () => {
    const win = tx({
      kind: WagerTransactionKind.Win,
      money: brl('90.00'),
      referenceExternalTransactionId: 'ext',
    });
    expect(evaluateReference(win, processed({}))).toEqual({ outcome: 'OK' });
  });
});
