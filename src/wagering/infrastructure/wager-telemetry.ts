import type { AppLogger } from '../../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../../shared/infrastructure/observability/metrics';
import type { WagerObserver, WagerOutcome } from '../application/wager-observer';

/** Transforma o desfecho de cada transação em métrica e numa linha de log. */
export class WagerTelemetry implements WagerObserver {
  constructor(
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  transactionHandled(o: WagerOutcome): void {
    const { result } = o;
    if (result.idempotentReplay) {
      this.metrics.duplicates.inc({ source: o.source });
    } else {
      this.metrics.transactions.inc({ status: result.status, kind: o.kind, source: o.source });
    }
    this.metrics.processing.observe({ source: o.source }, o.durationMs / 1000);

    // Só identificadores e desfecho. Nada de valor ou saldo.
    this.logger.info({
      event: 'wager.transaction',
      source: o.source,
      correlationId: o.correlationId,
      messageId: o.messageId,
      transactionId: result.transactionId,
      walletId: o.walletId,
      providerId: o.providerId,
      kind: o.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
      durationMs: Math.round(o.durationMs),
    });
  }
}
