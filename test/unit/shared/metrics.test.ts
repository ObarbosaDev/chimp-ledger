import { describe, expect, test } from 'bun:test';
import { AppMetrics } from '../../../src/shared/infrastructure/observability/metrics';

describe('AppMetrics', () => {
  test('lag da outbox entra na coleta com o valor medido', async () => {
    const metrics = new AppMetrics();
    metrics.trackOutboxLag(async () => 12.5);
    expect(await metrics.exposition()).toMatch(/^outbox_lag_seconds 12\.5$/m);
  });

  // Banco fora é justamente quando mais preciso das outras métricas: a falha
  // de uma medida não pode derrubar o /metrics inteiro.
  test('falha ao medir o lag não derruba as outras métricas', async () => {
    const metrics = new AppMetrics();
    metrics.deadLettered.inc();
    metrics.trackOutboxLag(() => Promise.reject(new Error('banco fora do ar')));

    const text = await metrics.exposition();
    expect(text).toMatch(/^dlq_messages_total 1$/m);
    // O prom-client escreve "Nan"; o Prometheus lê NaN sem diferenciar maiúsculas.
    expect(text).toMatch(/^outbox_lag_seconds nan$/im);
  });
});
