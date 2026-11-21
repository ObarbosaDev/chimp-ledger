import { Module } from '@nestjs/common';
import { CLOCK, CONFIG, ID_GENERATOR, UNIT_OF_WORK } from '../bootstrap/core.module';
import type { Clock, IdGenerator } from '../shared/application/ports';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import type { AppConfig } from '../shared/infrastructure/config';
import { GetTransaction } from './application/get-transaction';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WageringController } from './infrastructure/http/wagering.controller';

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
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, ReferenceRetryPolicy],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, retry: ReferenceRetryPolicy) =>
        new SubmitWagerTransaction(uow, ids, clock, retry),
    },
    {
      provide: GetTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetTransaction(uow),
    },
  ],
  exports: [SubmitWagerTransaction, ReferenceRetryPolicy],
})
export class WageringModule {}
