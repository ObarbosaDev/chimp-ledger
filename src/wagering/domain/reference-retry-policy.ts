export interface ReferenceRetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  ttlMs: number;
}

/**
 * Quanto tempo espero uma referência que ainda não chegou.
 *
 * Os valores padrão (2s, teto de 5min, 10 tentativas ou 1h) partem da ideia
 * de que mensagem fora de ordem costuma chegar em segundos. Se em uma hora a
 * BET não apareceu, o mais provável é que ela não exista, e deixar a
 * transação pendurada para sempre só esconde o problema do provedor.
 */
export class ReferenceRetryPolicy {
  constructor(private readonly config: ReferenceRetryConfig) {}

  /** Espera antes da próxima tentativa; `attempts` começa em 1. */
  delayFor(attempts: number): number {
    const exponential = this.config.baseDelayMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(exponential, this.config.maxDelayMs);
  }

  isExhausted(input: { attempts: number; createdAt: Date; now: Date }): boolean {
    const age = input.now.getTime() - input.createdAt.getTime();
    return input.attempts >= this.config.maxAttempts || age >= this.config.ttlMs;
  }
}
