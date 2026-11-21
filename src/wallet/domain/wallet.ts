import { sha256Hex } from '../../shared/domain/canonical-json';
import { CurrencyMismatchError, DomainError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidMovementError extends DomainError {
  readonly code = 'INVALID_MOVEMENT';
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  /** Quantos lançamentos a carteira já tem (número do último). */
  ledgerSequence: number;
  ledgerHeadHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação interna OPENING que justifica o saldo inicial no ledger. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Raiz do agregado de carteira. A única forma de mudar o saldo é por
 * debit/credit, e os dois devolvem o lançamento do ledger já calculado —
 * assim é impossível alterar saldo sem gerar a linha correspondente.
 *
 * Concorrência não é resolvida aqui: quem chama precisa ter a linha da
 * carteira travada (SELECT ... FOR UPDATE) antes de chamar debit/credit.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private _ledgerSequence: number,
    private _ledgerHeadHash: string,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMovementError('Saldo inicial não pode ser negativo');
    }

    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      Money.zero(currency),
      1,
      0,
      Wallet.genesisHash(props.id),
      props.at,
      props.at,
    );

    if (props.initialBalance.isZero()) {
      return { wallet };
    }

    // A abertura não sobe a versão: a carteira "nasce" na versão 1 já com o
    // crédito inicial, que vira o lançamento de sequência 1.
    const openingEntry = wallet.apply(
      LedgerDirection.Credit,
      {
        entryId: props.openingEntryId,
        transactionId: props.openingTransactionId,
        money: props.initialBalance,
        at: props.at,
      },
      { bumpVersion: false },
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.ledgerSequence,
      state.ledgerHeadHash,
      state.createdAt,
      state.updatedAt,
    );
  }

  /** Primeiro elo da corrente do ledger, derivado só do id da carteira. */
  static genesisHash(walletId: string): string {
    return sha256Hex(`genesis:${walletId}`);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Número do último lançamento. É separado da versão de propósito: a versão
   * conta mudanças de saldo desde a criação (começa em 1), o ledger conta
   * lançamentos (começa em 1 no primeiro, mesmo em carteira aberta com zero).
   */
  get ledgerSequence(): number {
    return this._ledgerSequence;
  }

  get ledgerHeadHash(): string {
    return this._ledgerHeadHash;
  }

  debit(movement: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(
        `Saldo ${this._balance} insuficiente para debitar ${movement.money}`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  // Calculo o lançamento antes de tocar no estado: se a criação falhar,
  // a carteira fica exatamente como estava.
  private apply(
    direction: LedgerDirection,
    movement: MovementProps,
    { bumpVersion }: { bumpVersion: boolean } = { bumpVersion: true },
  ): WalletLedgerEntry {
    if (!movement.money.isPositive()) {
      throw new InvalidMovementError(`Movimento precisa ser positivo, recebi ${movement.money}`);
    }
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit
        ? before.add(movement.money)
        : before.subtract(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      sequence: this._ledgerSequence + 1,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      prevHash: this._ledgerHeadHash,
      createdAt: movement.at,
    });

    this._balance = after;
    if (bumpVersion) this._version += 1;
    this._ledgerSequence = entry.sequence;
    this._ledgerHeadHash = entry.entryHash;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
