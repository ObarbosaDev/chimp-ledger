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
  INVALID_CURSOR: { status: 400, publicCode: 'INVALID_PAYLOAD' },
  WALLET_NOT_FOUND: { status: 404 },
  TRANSACTION_NOT_FOUND: { status: 404 },
  PROVIDER_NOT_ALLOWED: { status: 422 },
  WALLET_ALREADY_EXISTS: { status: 409 },
  IDEMPOTENCY_CONFLICT: { status: 409 },
};

export const RETRY_AFTER_SECONDS = 1;

export function toHttpError(error: unknown): HttpErrorResponse {
  const auth = authError(error);
  if (auth) return auth;

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

const REALM = 'chimp-ledger';

/**
 * Respostas de autenticação no formato da RFC 6750: o header
 * WWW-Authenticate diz ao cliente o que fazer (pegar token novo, pedir outro
 * escopo) sem ele ter que interpretar a mensagem.
 */
function authError(error: unknown): HttpErrorResponse | undefined {
  const code = (error as { code?: unknown } | null)?.code;

  if (code === 'UNAUTHENTICATED') {
    const missing = (error as { reason?: string }).reason === 'missing_token';
    return {
      status: 401,
      body: { code: 'UNAUTHENTICATED', message: (error as Error).message, retryable: false },
      headers: {
        'www-authenticate': missing
          ? `Bearer realm="${REALM}"`
          : `Bearer realm="${REALM}", error="invalid_token"`,
      },
    };
  }
  if (code === 'FORBIDDEN') {
    const scopes = (error as { requiredScopes?: readonly string[] }).requiredScopes ?? [];
    return {
      status: 403,
      body: { code: 'FORBIDDEN', message: (error as Error).message, retryable: false },
      headers: {
        'www-authenticate': `Bearer realm="${REALM}", error="insufficient_scope", scope="${scopes.join(' ')}"`,
      },
    };
  }
  if (code === 'PROVIDER_MISMATCH') {
    return {
      status: 403,
      body: { code: 'PROVIDER_MISMATCH', message: (error as Error).message, retryable: false },
    };
  }
  if (code === 'IDENTITY_PROVIDER_UNAVAILABLE') {
    return {
      status: 503,
      body: {
        code: 'TEMPORARILY_UNAVAILABLE',
        message: 'Não foi possível validar o token agora, tente novamente.',
        retryable: true,
      },
      headers: { 'retry-after': String(RETRY_AFTER_SECONDS) },
    };
  }
  return undefined;
}
