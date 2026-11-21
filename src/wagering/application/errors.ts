import { DomainError } from '../../shared/domain/errors';

/** Mesma chave de idempotência (ou mesmo id externo) com conteúdo diferente. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/**
 * Provedor desconhecido, inativo ou sem a moeda liberada. Não dá para gravar
 * a transação (a FK de provedor nem deixaria), então vira erro direto.
 */
export class ProviderNotAllowedError extends DomainError {
  readonly code = 'PROVIDER_NOT_ALLOWED';
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}
