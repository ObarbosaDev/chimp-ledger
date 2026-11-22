import { canonicalJson, sha256Hex } from '../../shared/domain/canonical-json';
import { DomainError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** Igual à versão da carteira depois do movimento. */
  sequence: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Hash do lançamento anterior da mesma carteira (ou o gênese). */
  prevHash: string;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  entryHash: string;
}

/**
 * Lançamento do razão. Não tem setter nem método de transição: depois de
 * criado ele só pode ser lido. Além disso cada lançamento carrega o hash do
 * anterior, formando uma corrente por carteira: se alguém alterar uma linha
 * direto no banco, a corrente quebra e a reconciliação aponta onde.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly sequence: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly prevHash: string,
    public readonly entryHash: string,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build({ ...props, entryHash: computeEntryHash(props) });
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Lançamento não fecha: ${props.balanceBefore} ${props.direction} ${props.money} ≠ ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter, com valor sempre positivo. */
  isBalanced(): boolean {
    if (!this.money.isPositive()) return false;
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Recalcula o hash a partir dos campos; false significa linha adulterada. */
  hasValidHash(): boolean {
    return computeEntryHash(this) === this.entryHash;
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id,
      s.walletId,
      s.transactionId,
      s.sequence,
      s.direction,
      s.money,
      s.balanceBefore,
      s.balanceAfter,
      s.prevHash,
      s.entryHash,
      s.createdAt,
    );
  }
}

function computeEntryHash(e: CreateLedgerEntryProps): string {
  const content = canonicalJson({
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    sequence: e.sequence,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    createdAt: e.createdAt.toISOString(),
  });
  return sha256Hex(`${e.prevHash}:${content}`);
}
