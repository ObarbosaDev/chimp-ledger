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
import type { AppConfig } from '../shared/infrastructure/config';
import { PollingLoop } from '../shared/infrastructure/polling-loop';
import { WageringModule } from '../wagering/wagering.module';
import { CoreModule, ORM } from './core.module';

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

  const loops = [
    new PollingLoop('outbox-relay', async () => (await relay.runOnce(new Date())) > 0, {
      idleDelayMs: config.OUTBOX_POLL_MS,
      errorDelayMs: 1_000,
      onError: reportError('outbox-relay'),
    }),
  ];

  return {
    start() {
      for (const loop of loops) loop.start();
    },
    async stop() {
      await Promise.all(loops.map((loop) => loop.stop()));
      sqs.destroy();
      await app.close();
    },
  };
}
