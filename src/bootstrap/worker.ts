import 'reflect-metadata';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SqsEventPublisher } from '../messaging/infrastructure/event-publisher';
import { OutboxRelay } from '../messaging/infrastructure/outbox-relay';
import {
  createSqsClient,
  queueNamesFrom,
  resolveQueueUrls,
} from '../messaging/infrastructure/sqs-client';
import { WagerConsumer } from '../messaging/infrastructure/wager-consumer';
import type { AppConfig } from '../shared/infrastructure/config';
import { PollingLoop } from '../shared/infrastructure/polling-loop';
import { ReprocessPendingReferences } from '../wagering/application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../wagering/application/submit-wager-transaction';
import { WagerProcessor } from '../wagering/application/wager-processor';
import { ReferenceRetryPolicy } from '../wagering/domain/reference-retry-policy';
import { WageringModule } from '../wagering/wagering.module';
import { CLOCK, CoreModule, ORM, UNIT_OF_WORK } from './core.module';

@Module({})
class WorkerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: WorkerModule, imports: [CoreModule.forRoot(config), WageringModule] };
  }
}

export interface Worker {
  start(): void;
  /** Para os loops (cada um termina a rodada atual) e fecha conexões. */
  stop(): Promise<void>;
}

/**
 * O processo de fundo. Mesma base de código e mesmo container da API, só
 * muda o papel: aqui rodam os loops que não atendem HTTP.
 */
export async function createWorker(config: AppConfig): Promise<Worker> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    logger: false,
  });
  const orm = app.get<MikroORM>(ORM);
  const sqs = createSqsClient(config);
  const queues = await resolveQueueUrls(sqs, queueNamesFrom(config));

  const relay = new OutboxRelay(orm, new SqsEventPublisher(sqs, queues.events), {
    batchSize: config.OUTBOX_BATCH_SIZE,
    leaseMs: config.OUTBOX_LEASE_MS,
  });

  const reportError = (loop: string) => (error: unknown) => {
    if (config.LOG_LEVEL !== 'silent') console.error(`[${loop}]`, error);
  };

  const consumer = new WagerConsumer(sqs, queues, app.get(SubmitWagerTransaction), {
    consumerName: config.SQS_CONSUMER_NAME,
    waitTimeSeconds: config.SQS_WAIT_TIME_SECONDS,
    retryBaseSeconds: config.SQS_RETRY_BASE_SECONDS,
  });

  const pendingReferences = new ReprocessPendingReferences(
    app.get(UNIT_OF_WORK),
    app.get(WagerProcessor),
    app.get(ReferenceRetryPolicy),
    app.get(CLOCK),
    {
      batchSize: config.REFERENCE_SWEEP_BATCH_SIZE,
      onError: (id, error) => reportError(`pending-references:${id}`)(error),
    },
  );

  const loops = [
    new PollingLoop('outbox-relay', async () => (await relay.runOnce(new Date())) > 0, {
      idleDelayMs: config.OUTBOX_POLL_MS,
      errorDelayMs: 1_000,
      onError: reportError('outbox-relay'),
    }),
    // O long polling já espera por mensagem, então a pausa ociosa é mínima.
    new PollingLoop('wager-consumer', async () => (await consumer.pollOnce()) > 0, {
      idleDelayMs: 10,
      errorDelayMs: 1_000,
      onError: reportError('wager-consumer'),
    }),
    new PollingLoop(
      'pending-references',
      async () => (await pendingReferences.runOnce(new Date())) > 0,
      {
        idleDelayMs: config.REFERENCE_SWEEP_POLL_MS,
        errorDelayMs: 1_000,
        onError: reportError('pending-references'),
      },
    ),
  ];

  return {
    start() {
      for (const loop of loops) loop.start();
    },
    async stop() {
      // Primeiro aviso o consumidor (não pega mensagem nova e devolve o que
      // ainda não começou), depois espero cada loop terminar a rodada atual.
      consumer.stop();
      await Promise.all(loops.map((loop) => loop.stop()));
      sqs.destroy();
      await app.close();
    },
  };
}
