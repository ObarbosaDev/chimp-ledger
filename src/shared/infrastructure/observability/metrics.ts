import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Métricas no formato Prometheus. Cada processo (api, worker) tem o seu
 * registro, exposto em /metrics. Os nomes seguem a convenção do Prometheus:
 * contador termina em _total, duração em _seconds.
 */
export class AppMetrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações de aposta tratadas, por status final, tipo e origem',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Requisições ou mensagens repetidas respondidas como replay',
    labelNames: ['source'],
    registers: [this.registry],
  });

  readonly processing = new Histogram({
    name: 'wager_processing_seconds',
    help: 'Tempo para tratar uma transação de aposta, do recebimento ao commit',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Operações que desistiram por lock_timeout na carteira',
    labelNames: ['source'],
    registers: [this.registry],
  });

  readonly consumerMessages = new Counter({
    name: 'wager_consumer_messages_total',
    help: 'Mensagens da fila por desfecho (acked, retry-later, dead-lettered, released)',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ pelo consumidor',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados a partir da outbox',
    registers: [this.registry],
  });

  readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas ao publicar evento da outbox (cada uma vira nova tentativa)',
    registers: [this.registry],
  });

  readonly authFailures = new Counter({
    name: 'auth_failures_total',
    help: 'Requisições recusadas na autenticação, por motivo',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliações que encontraram divergência entre saldo e ledger',
    registers: [this.registry],
  });

  /**
   * Idade do evento mais antigo ainda não publicado. Calculada na hora da
   * coleta, direto do banco, para nunca mostrar um valor velho.
   */
  trackOutboxLag(sample: () => Promise<number>): void {
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade, em segundos, do evento mais antigo ainda não publicado',
      registers: [this.registry],
      async collect() {
        this.set(await sample());
      },
    });
  }

  exposition(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
