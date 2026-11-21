import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/shared/domain/errors';
import { Money } from '../../../src/shared/domain/money';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction';
import {
  InsufficientFundsError,
  InvalidMovementError,
  Wallet,
} from '../../../src/wallet/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-20T12:00:00.000Z');
let seq = 0;
const nextId = () => `id-${++seq}`;

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: nextId(),
    at,
  });
}

const movement = (amount: string) => ({
  entryId: nextId(),
  transactionId: nextId(),
  money: brl(amount),
  at,
});

describe('Wallet.open', () => {
  test('nasce na versão 1 com o saldo inicial e um lançamento de abertura', () => {
    const { wallet, openingEntry } = openWallet('100.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.sequence).toBe(1);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('100.00');
    expect(wallet.ledgerHeadHash).toBe(openingEntry?.entryHash ?? '');
  });

  test('saldo inicial zero não gera lançamento e mantém versão 1', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(wallet.ledgerSequence).toBe(0);
    expect(wallet.ledgerHeadHash).toBe(Wallet.genesisHash('wallet-1'));
  });

  test('o primeiro lançamento de uma carteira aberta com zero é o de sequência 1', () => {
    const { wallet } = openWallet('0.00');
    const entry = wallet.credit(movement('10.00'));
    expect(entry.sequence).toBe(1);
    expect(wallet.ledgerSequence).toBe(1);
    expect(wallet.version).toBe(2);
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz saldo, sobe versão e devolve lançamento consistente', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(movement('80.00'));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.sequence).toBe(2);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit aumenta saldo e encadeia o hash no lançamento anterior', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(entry.prevHash).toBe(openingEntry?.entryHash ?? '');
    expect(wallet.ledgerHeadHash).toBe(entry.entryHash);
  });

  test('debit maior que o saldo lança e não altera nada', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('debit do saldo inteiro é permitido e zera a carteira', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(movement('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('movimento em outra moeda lança CurrencyMismatchError', () => {
    const { wallet } = openWallet('100.00');
    const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('movimento de valor zero é recusado (não existe lançamento vazio)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidMovementError);
    expect(() => wallet.debit(movement('0.00'))).toThrow(InvalidMovementError);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado salvo sem revalidar nada', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      ledgerSequence: 6,
      ledgerHeadHash: 'abc',
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.ledgerHeadHash).toBe('abc');
  });
});
