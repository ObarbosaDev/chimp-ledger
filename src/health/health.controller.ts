import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CONFIG, METRICS, ORM, SQS } from '../bootstrap/core.module';
import type { AppConfig } from '../shared/infrastructure/config';
import type { AppMetrics } from '../shared/infrastructure/observability/metrics';
import { checkReadiness } from './readiness';

/** Endpoints operacionais: abertos, sem autenticação. */
@Controller()
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: AppMetrics,
  ) {}

  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const { ready, checks } = await checkReadiness(
      this.orm,
      this.sqs,
      this.config.SQS_TRANSACTIONS_QUEUE,
    );
    reply.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks };
  }

  @Get('metrics')
  @Header('cache-control', 'no-store')
  async scrape(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('content-type', this.metrics.contentType);
    return this.metrics.exposition();
  }
}
