import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';

// Códigos do Postgres que significam "tenta de novo que passa":
// serialização, deadlock, lock_timeout, banco reiniciando, sem conexão.
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57P01', '57P03', '53300']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/** Erro de infraestrutura passageiro: vale devolver 503 ou deixar a fila reentregar. */
export function isTransientInfraError(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof LockWaitTimeoutException ||
    error instanceof DeadlockException
  ) {
    return true;
  }
  const code = sqlState(error);
  if (!code) return false;
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code) || code.startsWith('08');
}

/** Lock que não saiu dentro do lock_timeout — conta na métrica de conflito. */
export function isLockConflict(error: unknown): boolean {
  return error instanceof LockWaitTimeoutException || sqlState(error) === '55P03';
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  // O MikroORM embrulha o erro do driver; desço até achar um `code`.
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current =
      (current as { cause?: unknown }).cause ?? (current as { previous?: unknown }).previous;
  }
  return undefined;
}
