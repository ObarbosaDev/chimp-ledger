import {
  type MigrationDirection,
  runMigrations,
} from '../src/shared/infrastructure/database/migrator';

// Uso: bun scripts/migrate.ts up|down
// Roda com MIGRATOR_DATABASE_URL, nunca com o usuário da aplicação.
const direction = process.argv[2] as MigrationDirection | undefined;
const url = process.env.MIGRATOR_DATABASE_URL;

if (direction !== 'up' && direction !== 'down') {
  console.error('Uso: bun scripts/migrate.ts up|down');
  process.exit(1);
}
if (!url) {
  console.error('Defina MIGRATOR_DATABASE_URL (veja o .env.example).');
  process.exit(1);
}

await runMigrations(url, direction);
console.info(`Migrações (${direction}) aplicadas.`);
