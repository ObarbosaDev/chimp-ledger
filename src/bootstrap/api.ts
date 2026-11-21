import 'reflect-metadata';
import { type DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HealthController } from '../health/health.controller';
import type { AppConfig } from '../shared/infrastructure/config';
import { HttpErrorFilter } from '../shared/infrastructure/http/http-error.filter';
import type { AppLogger } from '../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../shared/infrastructure/observability/metrics';
import { WageringModule } from '../wagering/wagering.module';
import { WalletModule } from '../wallet/wallet.module';
import { CoreModule, type CoreOptions, LOGGER, METRICS } from './core.module';

@Module({})
class ApiModule {
  static forRoot(config: AppConfig, options: CoreOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [CoreModule.forRoot(config, options), WalletModule, WageringModule],
      controllers: [HealthController],
    };
  }
}

/** Monta a aplicação HTTP sem abrir porta — o main decide se escuta, o teste usa inject. */
export async function createApiApp(
  config: AppConfig,
  options: CoreOptions = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(config, options),
    new FastifyAdapter({ bodyLimit: config.HTTP_BODY_LIMIT_BYTES }),
    { logger: false },
  );
  app.useGlobalFilters(
    new HttpErrorFilter(app.get<AppLogger>(LOGGER), app.get<AppMetrics>(METRICS)),
  );
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
