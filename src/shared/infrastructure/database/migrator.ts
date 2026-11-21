import { Migrator } from '@mikro-orm/migrations';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';

/** up: aplica as pendentes · down: desfaz a última · reset: desfaz todas. */
export type MigrationDirection = 'up' | 'down' | 'reset';

/**
 * Roda as migrações versionadas de `migrations/` com o usuário dono do banco.
 * Sobe uma instância do MikroORM só para isso, sem entidades: migração aqui é
 * SQL escrito à mão, porque constraint, trigger e grant são justamente a
 * parte do esquema que eu não quero que um gerador decida por mim.
 */
export async function runMigrations(url: string, direction: MigrationDirection): Promise<void> {
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: url,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    preferTs: true,
    migrations: {
      path: 'migrations',
      pathTs: 'migrations',
      glob: '!(*.d).ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
  });

  try {
    const migrator = orm.getMigrator();
    if (direction === 'up') {
      await migrator.up();
    } else if (direction === 'down') {
      await migrator.down();
    } else {
      await migrator.down({ to: 0 });
    }
  } finally {
    await orm.close(true);
  }
}
