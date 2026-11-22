import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { CONFIG, LOGGER, METRICS } from '../bootstrap/core.module';
import type { AppConfig } from '../shared/infrastructure/config';
import type { AppLogger } from '../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../shared/infrastructure/observability/metrics';
import { AuthGuard } from './auth.guard';
import type { IdentityProvider } from './identity-provider';
import { JwtIdentityProvider } from './jwt-identity-provider';

export const IDENTITY_PROVIDER = Symbol('IdentityProvider');

@Module({
  providers: [
    {
      provide: IDENTITY_PROVIDER,
      inject: [CONFIG],
      useFactory: (config: AppConfig): IdentityProvider | undefined =>
        config.AUTH_ENABLED && config.AUTH_ISSUER_URL
          ? new JwtIdentityProvider({
              issuer: config.AUTH_ISSUER_URL,
              audience: config.AUTH_AUDIENCE,
            })
          : undefined,
    },
    {
      provide: APP_GUARD,
      inject: [Reflector, IDENTITY_PROVIDER, METRICS, LOGGER],
      useFactory: (
        reflector: Reflector,
        identity: IdentityProvider | undefined,
        metrics: AppMetrics,
        logger: AppLogger,
      ) => new AuthGuard(reflector, identity, metrics, logger),
    },
  ],
})
export class AuthModule {}
