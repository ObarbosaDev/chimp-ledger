import { Money } from '../../../shared/domain/money';
import type { LedgerDirection } from '../../domain/ledger-direction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { LedgerEntryRecord, WalletRecord } from './wallet.schemas';

// Tradução entre linha do banco e objeto de domínio. Só usa `rehydrate`:
// o que está no banco já passou pelas regras quando foi gravado.

const money = (amount: string, currency: string) => Money.from({ amount, currency });

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toJSON().amount,
    version: w.version,
    ledgerHeadHash: w.ledgerHeadHash,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    ledgerHeadHash: r.ledgerHeadHash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    sequence: e.sequence,
    direction: e.direction,
    amount: e.money.toJSON().amount,
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toJSON().amount,
    balanceAfter: e.balanceAfter.toJSON().amount,
    prevHash: e.prevHash,
    entryHash: e.entryHash,
    createdAt: e.createdAt,
  };
}

export function ledgerEntryFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    sequence: r.sequence,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    prevHash: r.prevHash,
    entryHash: r.entryHash,
    createdAt: r.createdAt,
  });
}
