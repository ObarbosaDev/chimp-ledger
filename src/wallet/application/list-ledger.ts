import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { MoneyProps } from '../../shared/domain/money';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletNotFoundError } from './errors';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  sequence: number;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Sequência do último item, quando há mais lançamentos depois dele. */
  nextAfterSequence: number | null;
}

export function toLedgerEntryView(e: WalletLedgerEntry): LedgerEntryView {
  return {
    id: e.id,
    transactionId: e.transactionId,
    sequence: e.sequence,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    prevHash: e.prevHash,
    entryHash: e.entryHash,
    createdAt: e.createdAt.toISOString(),
  };
}

export class ListLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, afterSequence: number, limit: number): Promise<LedgerPage> {
    return this.uow.run(async (tx) => {
      if (!(await tx.wallets.findById(walletId))) {
        throw new WalletNotFoundError(`Carteira ${walletId} não encontrada`);
      }
      // Peço um a mais só para saber se existe próxima página.
      const entries = await tx.ledger.listByWallet(walletId, afterSequence, limit + 1);
      const items = entries.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(toLedgerEntryView),
        nextAfterSequence: entries.length > limit && last ? last.sequence : null,
      };
    });
  }
}
