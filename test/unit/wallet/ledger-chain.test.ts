import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { verifyLedgerChain } from '../../../src/wallet/domain/ledger-chain';
import { Wallet } from '../../../src/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../../src/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-21T12:00:00.000Z');

function walletWithEntries(movements: Array<['credit' | 'debit', string]>) {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-0',
    openingEntryId: 'e-0',
    at,
  });
  const entries = openingEntry ? [openingEntry] : [];
  movements.forEach(([kind, amount], i) => {
    const movement = {
      entryId: `e-${i + 1}`,
      transactionId: `tx-${i + 1}`,
      money: brl(amount),
      at,
    };
    entries.push(kind === 'credit' ? wallet.credit(movement) : wallet.debit(movement));
  });
  return { wallet, entries };
}

/** Simula alguém mexendo numa linha direto no banco. */
function tamper(
  entry: WalletLedgerEntry,
  changes: Partial<Parameters<typeof WalletLedgerEntry.rehydrate>[0]>,
) {
  return WalletLedgerEntry.rehydrate({
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    direction: entry.direction,
    money: entry.money,
    balanceBefore: entry.balanceBefore,
    balanceAfter: entry.balanceAfter,
    prevHash: entry.prevHash,
    entryHash: entry.entryHash,
    createdAt: entry.createdAt,
    ...changes,
  });
}

describe('verifyLedgerChain', () => {
  test('ledger íntegro: corrente válida', () => {
    const { entries } = walletWithEntries([
      ['debit', '30.00'],
      ['credit', '5.50'],
    ]);
    expect(verifyLedgerChain('wallet-1', entries)).toEqual({ valid: true });
  });

  test('ledger vazio é válido', () => {
    expect(verifyLedgerChain('wallet-1', [])).toEqual({ valid: true });
  });

  test('valor alterado numa linha quebra a corrente nela', () => {
    const { entries } = walletWithEntries([
      ['debit', '30.00'],
      ['credit', '5.50'],
    ]);
    const second = entries[1] as WalletLedgerEntry;
    entries[1] = tamper(second, { money: brl('3.00'), balanceAfter: brl('97.00') });
    expect(verifyLedgerChain('wallet-1', entries)).toEqual({
      valid: false,
      firstBrokenSequence: 2,
    });
  });

  test('lançamento removido do meio aparece como buraco na sequência', () => {
    const { entries } = walletWithEntries([
      ['debit', '30.00'],
      ['credit', '5.50'],
      ['debit', '1.00'],
    ]);
    entries.splice(1, 1);
    expect(verifyLedgerChain('wallet-1', entries)).toEqual({
      valid: false,
      firstBrokenSequence: 2,
    });
  });

  test('primeiro lançamento que não parte do gênese é inválido', () => {
    const { entries } = walletWithEntries([]);
    const first = entries[0] as WalletLedgerEntry;
    entries[0] = tamper(first, { prevHash: '0'.repeat(64) });
    expect(verifyLedgerChain('wallet-1', entries)).toEqual({
      valid: false,
      firstBrokenSequence: 1,
    });
  });
});
