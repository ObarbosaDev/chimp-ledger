import type { AppLogger } from '../../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../../shared/infrastructure/observability/metrics';
import type { ReconciliationAlarm, ReconciliationReport } from '../application/reconcile-wallet';

/**
 * Divergência vira métrica (para alerta) e uma linha de log com o resumo.
 * A diferença vai em texto e sem os saldos completos: dá para investigar
 * sem espalhar o saldo da carteira pelos logs.
 */
export class ObservedReconciliationAlarm implements ReconciliationAlarm {
  constructor(
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  divergence(report: ReconciliationReport): void {
    this.metrics.reconciliationDivergences.inc();
    this.logger.warn({
      event: 'reconciliation.divergence',
      walletId: report.walletId,
      chainValid: report.chainValid,
      firstBrokenSequence: report.firstBrokenSequence,
      checkedEntries: report.checkedEntries,
      differenceIsZero: report.difference.amount === '0.00',
    });
  }
}
