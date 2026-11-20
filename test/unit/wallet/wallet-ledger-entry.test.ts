import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { LedgerDirection } from '../../../src/wallet/domain/ledger-direction';
import {
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  sequence: 2,
  direction: LedgerDirection.Debit,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('70.00'),
  prevHash: 'a'.repeat(64),
  createdAt: new Date('2026-11-20T12:00:00.000Z'),
};

describe('WalletLedgerEntry.create', () => {
  test('aceita débito com aritmética certa e calcula o hash', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.hasValidHash()).toBe(true);
  });

  test('aceita crédito com aritmética certa', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      balanceAfter: brl('130.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    ['saldo final errado', { balanceAfter: brl('71.00') }],
    ['direção trocada', { direction: LedgerDirection.Credit }],
    ['valor zero', { money: brl('0.00'), balanceAfter: brl('100.00') }],
  ])('recusa lançamento desbalanceado: %s', (_caso, override) => {
    expect(() => WalletLedgerEntry.create({ ...base, ...override })).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test('o hash muda se qualquer campo relevante mudar', () => {
    const a = WalletLedgerEntry.create(base);
    const b = WalletLedgerEntry.create({ ...base, prevHash: 'b'.repeat(64) });
    const c = WalletLedgerEntry.create({ ...base, sequence: 3 });
    expect(a.entryHash).not.toBe(b.entryHash);
    expect(a.entryHash).not.toBe(c.entryHash);
  });

  test('o mesmo conteúdo gera sempre o mesmo hash', () => {
    expect(WalletLedgerEntry.create(base).entryHash).toBe(WalletLedgerEntry.create(base).entryHash);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('detecta adulteração: valor trocado no banco não bate com o hash salvo', () => {
    const original = WalletLedgerEntry.create(base);
    const tampered = WalletLedgerEntry.rehydrate({
      ...base,
      money: brl('3.00'),
      balanceAfter: brl('97.00'),
      entryHash: original.entryHash,
    });
    expect(tampered.hasValidHash()).toBe(false);
  });

  test('não tem nenhum método que altere o estado', () => {
    const entry = WalletLedgerEntry.create(base);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(methods.sort()).toEqual(['constructor', 'hasValidHash', 'isBalanced'].sort());
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
