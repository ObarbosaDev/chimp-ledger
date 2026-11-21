import 'reflect-metadata';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { checkReadiness } from '../health/readiness';
import {
  type EventPublisher,
  SqsEventPublisher,
} from '../messaging/infrastructure/event-publisher';
import { OutboxRelay } from '../messaging/infrastructure/outbox-relay';
import { queueNamesFrom, resolveQueueUrls } from '../messaging/infrastructure/sqs-client';
import { WagerConsumer } from '../messaging/infrastructure/wager-consumer';
import type { AppConfig } from '../shared/infrastructure/config';
import { isLockConflict } from '../shared/infrastructure/errors/infra-errors';
import type { AppLogger } from '../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../shared/infrastructure/observability/metrics';
import { PollingLoop } from '../shared/infrastructure/polling-loop';
import { ReprocessPendingReferences } from '../wagering/application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../wagering/application/submit-wager-transaction';
import type { WagerObserver } from '../wagering/application/wager-observer';
import { WagerProcessor } from '../wagering/application/wager-processor';
import { ReferenceRetryPolicy } from '../wagering/domain/reference-retry-policy';
import { WAGER_OBSERVER, WageringModule } from '../wagering/wagering.module';
import {
  CLOCK,
  CoreModule,
  type CoreOptions,
  LOGGER,
  METRICS,
  ORM,
  SQS,
  UNIT_OF_WORK,
} from './core.module';

@Module({})
class WorkerModule {
  static forRoot(config: AppConfig, options: CoreOptions): DynamicModule {
    return { module: WorkerModule, imports: [CoreModule.forRoot(config, options), WageringModule] };
  }
}

export interface Worker {
  /** Endereço do servidor de health checks e métricas do worker. */
  readonly url: string;
  start(): void;
  /** Para os loops (cada um termina a rodada atual) e fecha conexões. */
  stop(): Promise<void>;
}

/**
 * O processo de fundo. Mesma base de código e mesmo container da API, só
 * muda o papel: aqui rodam os loops que não atendem a provedores. Ele ainda
 * abre uma porta HTTP pequena, só para health checks e /metrics.
 */
export async function createWorker(config: AppConfig, options: CoreOptions = {}): Promise<Worker> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, options), {
    logger: false,
  });
  const orm = app.get<MikroORM>(ORM);
  const sqs = app.get<SQSClient>(SQS);
  const logger = app.get<AppLogger>(LOGGER).child({ role: 'worker' });
  const metrics = app.get<AppMetrics>(METRICS);
  const queues = await resolveQueueUrls(sqs, queueNamesFrom(config));

  metrics.trackOutboxLag(() => outboxLagSeconds(orm));

  const relay = new OutboxRelay(
    orm,
    countingPublisher(new SqsEventPublisher(sqs, queues.events), metrics),
    { aggregatesPerRound: config.OUTBOX_AGGREGATES_PER_ROUND, leaseMs: config.OUTBOX_LEASE_MS },
  );

  const consumer = new WagerConsumer(
    sqs,
    queues,
    app.get(SubmitWagerTransaction),
    {
      consumerName: config.SQS_CONSUMER_NAME,
      waitTimeSeconds: config.SQS_WAIT_TIME_SECONDS,
      retryBaseSeconds: config.SQS_RETRY_BASE_SECONDS,
      onFailure: (error, kind, sqsMessageId) => {
        if (isLockConflict(error)) metrics.lockConflicts.inc({ source: 'sqs' });
        logger.warn({ event: 'wager.message_failed', kind, sqsMessageId, err: error });
      },
    },
    (outcome) => {
      metrics.consumerMessages.inc({ outcome });
      if (outcome === 'dead-lettered') metrics.deadLettered.inc();
    },
  );

  const pendingReferences = new ReprocessPendingReferences(
    app.get(UNIT_OF_WORK),
    app.get(WagerProcessor),
    app.get(ReferenceRetryPolicy),
    app.get(CLOCK),
    {
      batchSize: config.REFERENCE_REPROCESS_BATCH_SIZE,
      observer: app.get<WagerObserver>(WAGER_OBSERVER),
      onError: (transactionId, error) => {
        if (isLockConflict(error)) metrics.lockConflicts.inc({ source: 'reprocess' });
        logger.warn({ event: 'wager.reprocess_failed', transactionId, err: error });
      },
    },
  );

  const loopError = (loop: string) => (error: unknown) =>
    logger.error({ event: 'worker.loop_failed', loop, err: error });

  const loops = [
    new PollingLoop('outbox-relay', async () => (await relay.runOnce(new Date())) > 0, {
      idleDelayMs: config.OUTBOX_POLL_MS,
      errorDelayMs: 1_000,
      onError: loopError('outbox-relay'),
    }),
    // O long polling já espera por mensagem, então a pausa ociosa é mínima.
    new PollingLoop('wager-consumer', async () => (await consumer.pollOnce()) > 0, {
      idleDelayMs: 10,
      errorDelayMs: 1_000,
      onError: loopError('wager-consumer'),
    }),
    new PollingLoop(
      'pending-references',
      async () => (await pendingReferences.runOnce(new Date())) > 0,
      {
        idleDelayMs: config.REFERENCE_REPROCESS_POLL_MS,
        errorDelayMs: 1_000,
        onError: loopError('pending-references'),
      },
    ),
  ];

  const server = Bun.serve({
    port: config.WORKER_HTTP_PORT,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/health/live') return Response.json({ status: 'ok' });
      if (pathname === '/health/ready') {
        const { ready, checks } = await checkReadiness(orm, sqs, config.SQS_TRANSACTIONS_QUEUE);
        return Response.json(
          { status: ready ? 'ok' : 'unavailable', checks },
          { status: ready ? 200 : 503 },
        );
      }
      if (pathname === '/metrics') {
        return new Response(await metrics.exposition(), {
          headers: { 'content-type': metrics.contentType },
        });
      }
      return new Response(null, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    start() {
      for (const loop of loops) loop.start();
      logger.info({ event: 'worker.started', port: server.port });
    },
    async stop() {
      // Primeiro aviso o consumidor (não pega mensagem nova e devolve o que
      // ainda não começou), depois espero cada loop terminar a rodada atual.
      consumer.stop();
      await Promise.all(loops.map((loop) => loop.stop()));
      server.stop();
      logger.info({ event: 'worker.stopped' });
      await app.close();
    },
  };
}

/** Conta publicações e falhas sem mexer no relay. */
function countingPublisher(publisher: EventPublisher, metrics: AppMetrics): EventPublisher {
  return {
    async publish(events) {
      const outcome = await publisher.publish(events);
      metrics.outboxPublished.inc(outcome.published.length);
      metrics.outboxFailures.inc(outcome.failed.length);
      return outcome;
    },
  };
}

async function outboxLagSeconds(orm: MikroORM): Promise<number> {
  const [row] = await orm.em
    .fork()
    .getConnection()
    .execute<{ lag: string | number }[]>(
      `select coalesce(extract(epoch from now() - min(occurred_at)), 0) as lag
         from outbox_messages
        where published_at is null`,
    );
  return Number(row?.lag ?? 0);
}
