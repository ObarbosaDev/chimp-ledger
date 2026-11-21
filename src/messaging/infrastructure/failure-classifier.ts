import { ZodError } from 'zod';
import { DomainError } from '../../shared/domain/errors';

/**
 * O que fazer com uma mensagem que deu erro:
 *
 * - business: decisão final de negócio — confirma (ack) e segue a vida;
 * - permanent: a mensagem em si está errada — reenviar nunca vai funcionar,
 *   vai direto para a DLQ para alguém olhar;
 * - transient: problema nosso e passageiro — não confirma, a fila entrega
 *   de novo com backoff. Se insistir, o redrive manda para a DLQ sozinho.
 */
export type FailureKind = 'business' | 'permanent' | 'transient';

const PAYLOAD_PROBLEMS = new Set(['INVALID_PAYLOAD', 'INVALID_MONEY', 'INVALID_MOVEMENT']);

const BUSINESS_OUTCOMES = new Set([
  'IDEMPOTENCY_CONFLICT',
  'WALLET_NOT_FOUND',
  'PROVIDER_NOT_ALLOWED',
  'CURRENCY_MISMATCH',
]);

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof ZodError || error instanceof SyntaxError) return 'permanent';
  if (error instanceof DomainError) {
    if (PAYLOAD_PROBLEMS.has(error.code)) return 'permanent';
    if (BUSINESS_OUTCOMES.has(error.code)) return 'business';
  }
  // Erro de infra (banco fora, lock_timeout) ou bug que eu não previ: tento
  // de novo. Bug de verdade vai acabar na DLQ depois de algumas entregas, o
  // que é melhor do que confirmar e perder a operação em silêncio.
  return 'transient';
}
