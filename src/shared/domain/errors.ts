/**
 * Erro de regra de negócio. Tudo que herda daqui é previsível e tem um
 * `code` estável — é esse código que a camada HTTP/fila usa para decidir
 * status e se a operação pode ser reenviada. Mensagem é para humano ler,
 * nunca para máquina interpretar.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Moeda ${received} não pode ser combinada com ${expected}`);
  }
}
