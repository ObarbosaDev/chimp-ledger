import type { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Clock, IdGenerator } from '../shared/application/ports';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import type { AppConfig } from '../shared/infrastructure/config';
import { MikroOrmUnitOfWork } from '../shared/infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from '../shared/infrastructure/database/orm';
import { SystemClock, UuidV7Generator } from '../shared/infrastructure/system';

// Tokens das portas. Os casos de uso dependem das interfaces; quem decide a
// implementação concreta é só este módulo.
export const CONFIG = Symbol('AppConfig');
export const ORM = Symbol('MikroORM');
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');

/** Infra compartilhada por api e worker: config, banco, relógio e ids. */
@Module({})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: ORM, useFactory: () => createOrm(config) },
        {
          provide: UNIT_OF_WORK,
          inject: [ORM],
          useFactory: (orm: MikroORM): UnitOfWork =>
            new MikroOrmUnitOfWork(orm, config.LOCK_TIMEOUT_MS),
        },
        { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
        { provide: ID_GENERATOR, useFactory: (): IdGenerator => new UuidV7Generator() },
      ],
      exports: [CONFIG, ORM, UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
