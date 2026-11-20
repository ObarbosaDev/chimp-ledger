import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Uso uma instância isolada do Decimal para não depender da configuração
// global da lib (outro módulo poderia mudar a precisão sem eu perceber).
// 40 dígitos sobram para NUMERIC(19,2) e nunca deixam a soma arredondar.
const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// Contrato de entrada: sempre duas casas, sem sinal, sem zero à esquerda e
// sem notação científica. Preferi ser rígido aqui do que "consertar" o valor
// do provedor — se eu arredondo "1.005", alguém ganha ou perde um centavo.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Entrada vinda de fora (API, fila, banco). Só aceita valor não negativo. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Valor monetário inválido: "${String(amount)}"`);
    }
    return new Money(new Exact(amount), Money.validCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Exact(0), Money.validCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  // O resultado pode ficar negativo (ex.: diferença da reconciliação).
  // Quem garante saldo não negativo é a Wallet, não o Money.
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    // Decimal guarda "-0" depois de um negate(); normalizo para não vazar
    // "-0.00" num evento ou resposta.
    const normalized = this.value.isZero() ? new Exact(0) : this.value;
    return { amount: normalized.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Moeda inválida: "${String(currency)}"`);
    }
    return currency;
  }
}
