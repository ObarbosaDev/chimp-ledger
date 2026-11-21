import { Module } from '@nestjs/common';
import {
  CLOCK,
  CONFIG,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  UNIT_OF_WORK,
} from '../bootstrap/core.module';
import type { Clock, IdGenerator } from '../shared/application/ports';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import type { AppConfig } from '../shared/infrastructure/config';
import type { AppLogger } from '../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../shared/infrastructure/observability/metrics';
import { GetTransaction } from './application/get-transaction';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import type { WagerObserver } from './application/wager-observer';
import { WagerProcessor } from './application/wager-processor';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WagerTelemetry } from './infrastructure/wager-telemetry';

export const WAGER_OBSERVER = Symbol('WagerObserver');

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ReferenceRetryPolicy,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        new ReferenceRetryPolicy({
          baseDelayMs: config.REFERENCE_RETRY_BASE_MS,
          maxDelayMs: config.REFERENCE_RETRY_MAX_DELAY_MS,
          maxAttempts: config.REFERENCE_RETRY_MAX_ATTEMPTS,
          ttlMs: config.REFERENCE_RETRY_TTL_MS,
        }),
    },
    {
      provide: WagerProcessor,
      inject: [ID_GENERATOR, ReferenceRetryPolicy],
      useFactory: (ids: IdGenerator, retry: ReferenceRetryPolicy) => new WagerProcessor(ids, retry),
    },
    {
      provide: WAGER_OBSERVER,
      inject: [METRICS, LOGGER],
      useFactory: (metrics: AppMetrics, logger: AppLogger): WagerObserver =>
        new WagerTelemetry(metrics, logger),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, WagerProcessor, WAGER_OBSERVER],
      useFactory: (
        uow: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        processor: WagerProcessor,
        observer: WagerObserver,
      ) => new SubmitWagerTransaction(uow, ids, clock, processor, observer),
    },
    {
      provide: GetTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetTransaction(uow),
    },
  ],
  exports: [SubmitWagerTransaction, WagerProcessor, ReferenceRetryPolicy, WAGER_OBSERVER],
})
export class WageringModule {}
