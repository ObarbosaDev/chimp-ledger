import type { ReconciliationAlarm, ReconciliationReport } from '../application/reconcile-wallet';

/**
 * Divergência vira uma linha de log estruturado, fácil de filtrar e alertar.
 * Só identificadores e o resumo: nada de payload financeiro completo.
 */
export class LoggingReconciliationAlarm implements ReconciliationAlarm {
  constructor(private readonly write: (line: string) => void = console.warn) {}

  divergence(report: ReconciliationReport): void {
    this.write(
      JSON.stringify({
        level: 'warn',
        event: 'reconciliation.divergence',
        walletId: report.walletId,
        difference: report.difference.amount,
        currency: report.difference.currency,
        chainValid: report.chainValid,
        firstBrokenSequence: report.firstBrokenSequence,
        checkedEntries: report.checkedEntries,
      }),
    );
  }
}
