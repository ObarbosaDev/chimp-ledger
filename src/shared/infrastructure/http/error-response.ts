import { DomainError } from '../../domain/errors';
import { isTransientInfraError } from '../errors/infra-errors';

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export interface HttpErrorResponse {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

/**
 * Mapa único de erro → status. Fica num lugar só para todos os endpoints
 * responderem igual. A regra que o provedor precisa entender:
 *
 *   400 o pedido está malformado — corrija antes de reenviar
 *   404 o recurso não existe
 *   409 conflito (idempotência ou duplicidade) — não reenvie igual
 *   422 regra de negócio recusou — decisão final, ver failureCode
 *   202 aceito, processamento pendente
 *   503 problema nosso e passageiro — reenvie depois do Retry-After
 */
const DOMAIN_STATUS: Record<string, { status: number; publicCode?: string }> = {
  INVALID_PAYLOAD: { status: 400 },
  INVALID_MONEY: { status: 400, publicCode: 'INVALID_PAYLOAD' },
  INVALID_MOVEMENT: { status: 400, publicCode: 'INVALID_PAYLOAD' },
  WALLET_NOT_FOUND: { status: 404 },
  TRANSACTION_NOT_FOUND: { status: 404 },
  WALLET_ALREADY_EXISTS: { status: 409 },
  IDEMPOTENCY_CONFLICT: { status: 409 },
};

export const RETRY_AFTER_SECONDS = 1;

export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof DomainError) {
    const mapped = DOMAIN_STATUS[error.code];
    if (mapped) {
      return {
        status: mapped.status,
        body: { code: mapped.publicCode ?? error.code, message: error.message, retryable: false },
      };
    }
  }
  if (isTransientInfraError(error)) {
    return {
      status: 503,
      body: {
        code: 'TEMPORARILY_UNAVAILABLE',
        message: 'Falha temporária de infraestrutura, tente novamente.',
        retryable: true,
      },
      headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
    };
  }
  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: 'Erro inesperado.', retryable: false },
  };
}
