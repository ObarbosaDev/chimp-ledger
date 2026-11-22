import type { Clock, IdGenerator } from '../../shared/application/ports';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletNotFoundError } from './errors';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

/**
 * Abre a carteira. Quando o saldo inicial é maior que zero, a transação
 * OPENING e o lançamento de crédito entram na mesma transação SQL, e o
 * banco confere isso no commit (trigger diferido), então não tem como sair
 * carteira com saldo "do nada".
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: { playerId: string; initialBalance: MoneyProps }): Promise<WalletView> {
    const initialBalance = Money.from(input.initialBalance);
    const at = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      at,
    });

    // Ordem importa por causa das FKs: carteira → transação → lançamento.
    await this.uow.run(async (tx) => {
      await tx.wallets.insert(wallet);
      if (openingEntry) {
        await tx.transactions.insert(
          WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId,
            playerId: input.playerId,
            money: initialBalance,
            at,
          }),
        );
        await tx.ledger.append(openingEntry);
      }
    });

    return toWalletView(wallet);
  }
}

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((tx) => tx.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(`Carteira ${walletId} não encontrada`);
    return toWalletView(wallet);
  }
}
