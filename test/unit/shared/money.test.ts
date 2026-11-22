import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/shared/domain/errors';
import { Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money — contrato de entrada', () => {
  test('aceita string com exatamente duas casas e devolve o mesmo formato', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.00').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    ['   '],
    ['1.005'],
    ['10.5'],
    ['10'],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['1,00'],
    [' 1.00'],
    ['0x10'],
    ['100000000000000000.00'],
  ])('recusa amount inválido %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('recusa amount que não é string (number nunca entra no domínio)', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each([['brl'], ['BR'], ['REAL'], [''], ['B1L']])('recusa moeda fora do ISO-4217 %p', (c) => {
    expect(() => Money.from({ amount: '1.00', currency: c })).toThrow(InvalidMoneyError);
  });

  // Arredondar em silêncio é decidir centavo no lugar do provedor. Valor com
  // casa a mais volta como erro de contrato, e ele corrige o que mandou.
  test('nunca arredonda: terceira casa é recusada, mesmo sendo zero', () => {
    for (const amount of ['1.005', '1.004', '1.995', '1.000']) {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
    expect(brl('1.99').add(brl('0.01')).toJSON().amount).toBe('2.00');
  });

  test('aceita o teto de NUMERIC(19,2)', () => {
    expect(brl('99999999999999999.99').toJSON().amount).toBe('99999999999999999.99');
  });
});

describe('Money — aritmética exata', () => {
  test('0.10 + 0.20 é exatamente 0.30 (onde number erra)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('soma de valores grandes não perde centavos', () => {
    expect(brl('99999999999999990.01').add(brl('9.98')).toJSON().amount).toBe(
      '99999999999999999.99',
    );
  });

  test('subtração pode ficar negativa internamente e serializa com sinal', () => {
    const diff = brl('5.00').subtract(brl('7.50'));
    expect(diff.isNegative()).toBe(true);
    expect(diff.toJSON().amount).toBe('-2.50');
  });

  test('negate de zero não vira "-0.00"', () => {
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
  });

  test('é imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
  });

  test('comparações', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  test('toString é legível para log e erro', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});

describe('Money — moedas diferentes', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test.each([
    ['add', () => brl('1.00').add(usd)],
    ['subtract', () => brl('1.00').subtract(usd)],
    ['isLessThan', () => brl('1.00').isLessThan(usd)],
  ])('%s entre BRL e USD lança CurrencyMismatchError', (_name, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });
});
