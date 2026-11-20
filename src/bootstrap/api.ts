import 'reflect-metadata';
import { type DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '../shared/infrastructure/config';
import { HttpErrorFilter } from '../shared/infrastructure/http/http-error.filter';
import { WalletModule } from '../wallet/wallet.module';
import { CoreModule } from './core.module';

@Module({})
class ApiModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: ApiModule, imports: [CoreModule.forRoot(config), WalletModule] };
  }
}

/** Monta a aplicação HTTP sem abrir porta — o main decide se escuta, o teste usa inject. */
export async function createApiApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(config),
    new FastifyAdapter({ bodyLimit: config.HTTP_BODY_LIMIT_BYTES }),
    { logger: false },
  );
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
