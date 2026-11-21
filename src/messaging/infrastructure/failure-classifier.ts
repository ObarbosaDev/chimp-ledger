import { ZodError } from 'zod';
import { DomainError } from '../../shared/domain/errors';

/**
 * O que fazer com uma mensagem que deu erro:
 *
 * - business: decisão de negócio que já ficou registrada — confirma (ack);
 * - permanent: reenviar a mesma mensagem nunca vai funcionar — vai direto
 *   para a DLQ, com o motivo, para alguém olhar;
 * - transient: problema nosso e passageiro — não confirma, a fila entrega
 *   de novo com backoff. Se insistir, o redrive manda para a DLQ sozinho.
 */
export type FailureKind = 'business' | 'permanent' | 'transient';

const PERMANENT = new Set([
  // a mensagem está malformada
  'INVALID_PAYLOAD',
  'INVALID_MONEY',
  'INVALID_MOVEMENT',
  // carteira ou provedor inexistente: nenhuma transação chega a ser gravada,
  // então confirmar seria perder a operação sem rastro
  'WALLET_NOT_FOUND',
  'PROVIDER_NOT_ALLOWED',
]);

// A transação original já existe no banco; a mensagem repetida não muda nada.
const BUSINESS = new Set(['IDEMPOTENCY_CONFLICT']);

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof ZodError || error instanceof SyntaxError) return 'permanent';
  if (error instanceof DomainError) {
    if (PERMANENT.has(error.code)) return 'permanent';
    if (BUSINESS.has(error.code)) return 'business';
  }
  // Erro de infra (banco fora, lock_timeout) ou bug que eu não previ: tento
  // de novo. Bug de verdade vai acabar na DLQ depois de algumas entregas, o
  // que é melhor do que confirmar e perder a operação em silêncio.
  return 'transient';
}

/** Motivo legível por máquina e por gente, gravado como atributo na DLQ. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = error instanceof DomainError ? `${error.code}: ${message}` : message;
  return reason.slice(0, 256);
}
