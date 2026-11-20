import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { FailureCode } from '../../../src/wagering/domain/failure-code';
import {
  type CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-20T12:00:00.000Z');

function props(over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: t0,
    ...over,
  };
}

const create = (over: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(over));

describe('WagerTransaction.create', () => {
  test('nasce PENDING e sem nada resolvido', () => {
    const tx = create();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.resultBalance).toBeUndefined();
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s sem referência é recusado',
    (kind) => {
      expect(() => create({ kind })).toThrow(InvalidWagerTransactionError);
    },
  );

  test('BET com referência é recusado (aposta não reverte nada)', () => {
    expect(() =>
      create({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'x' }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('OPENING não pode nascer pelo create (só a abertura de carteira cria)', () => {
    expect(() => create({ kind: WagerTransactionKind.Opening })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])('%s com valor zero é recusado', (kind) => {
    expect(() =>
      create({ kind, money: brl('0.00'), referenceExternalTransactionId: 'ref' }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('LOSS aceita valor zero (só registra o resultado)', () => {
    expect(create({ kind: WagerTransactionKind.Loss, money: brl('0.00') }).money.isZero()).toBe(
      true,
    );
  });

  test('campo de identificação vazio é recusado', () => {
    expect(() => create({ roundId: '' })).toThrow(InvalidWagerTransactionError);
    expect(() => create({ providerId: '  ' })).toThrow(InvalidWagerTransactionError);
  });

  test('createOpening gera uma OPENING já processada', () => {
    const tx = WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('100.00'),
      at: t0,
    });
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.resultBalance?.toJSON().amount).toBe('100.00');
  });
});

describe('transições de estado', () => {
  test('PENDING → PROCESSED guarda referência, momento e saldo resultante', () => {
    const tx = create();
    tx.markProcessed({ referenceTransactionId: undefined, at: t0, resultBalance: brl('75.00') });
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(t0);
    expect(tx.resultBalance?.toJSON().amount).toBe('75.00');
  });

  test('PENDING → REJECTED guarda o código de falha', () => {
    const tx = create();
    tx.reject({ code: FailureCode.InsufficientFunds, at: t0, resultBalance: brl('10.00') });
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING → FAILED é terminal e auditável', () => {
    const tx = create();
    tx.fail({ code: FailureCode.InfrastructurePermanent, at: t0 });
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING_REFERENCE pode ser reagendado e depois processado', () => {
    const tx = create({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'b' });
    tx.markPendingReference(t0);
    tx.markPendingReference(new Date(t0.getTime() + 5_000));
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
    tx.markProcessed({ referenceTransactionId: 'tx-bet', at: t0, resultBalance: brl('1.00') });
    expect(tx.referenceTransactionId).toBe('tx-bet');
  });

  const terminalize = {
    PROCESSED: (tx: WagerTransaction) =>
      tx.markProcessed({ referenceTransactionId: undefined, at: t0, resultBalance: brl('1.00') }),
    REJECTED: (tx: WagerTransaction) =>
      tx.reject({ code: FailureCode.InsufficientFunds, at: t0, resultBalance: brl('1.00') }),
    FAILED: (tx: WagerTransaction) =>
      tx.fail({ code: FailureCode.InfrastructurePermanent, at: t0 }),
  };

  test.each(Object.keys(terminalize))('%s é terminal: qualquer nova transição lança', (state) => {
    const tx = create();
    terminalize[state as keyof typeof terminalize](tx);
    for (const next of Object.values(terminalize)) {
      expect(() => next(tx)).toThrow(InvalidTransactionStateError);
    }
    expect(() => tx.markPendingReference(t0)).toThrow(InvalidTransactionStateError);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance é falso só para LOSS', () => {
    expect(create({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(create({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(true);
  });

  test('requiresReference só para REFUND e ROLLBACK', () => {
    expect(create().requiresReference()).toBe(false);
    expect(
      create({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'x',
      }).requiresReference(),
    ).toBe(true);
  });

  test('matchesPayload compara o hash', () => {
    expect(create().matchesPayload('hash-1')).toBe(true);
    expect(create().matchesPayload('outro')).toBe(false);
  });

  test('direção do ledger por tipo', () => {
    expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      create({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'b',
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rollback = create({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'r',
    });
    const bet = create();
    const win = create({ kind: WagerTransactionKind.Win });
    const refund = create({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'b',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem a referência em mãos e LOSS não têm direção (erro de programação)', () => {
    const rollback = create({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'r',
    });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => create({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });
});
