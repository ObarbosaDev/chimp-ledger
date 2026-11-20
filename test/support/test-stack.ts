import { SQSClient } from '@aws-sdk/client-sqs';
import { LocalstackContainer } from '@testcontainers/localstack';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { QueueNames } from '../../src/messaging/infrastructure/sqs-topology';

export interface TestStack {
  /** Dono do banco: roda migrações e consegue mexer em tudo. */
  migratorUrl: string;
  /** Usuário da aplicação, com os grants mínimos da migração. */
  appUrl: string;
  ownerPool: pg.Pool;
  appPool: pg.Pool;
  sqsEndpoint: string;
  sqs: SQSClient;
  queueNames: QueueNames;
  sql<T>(text: string, params?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const LOCALSTACK_IMAGE = 'localstack/localstack:4.4';
const ROLES_SQL = 'docker/postgres/01-roles.sql';

/**
 * Sobe Postgres e LocalStack reais para o arquivo de teste. Cada arquivo
 * tem a sua stack, então um teste nunca enxerga lixo de outro.
 */
export async function startTestStack(): Promise<TestStack> {
  const [postgres, localstack] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new LocalstackContainer(LOCALSTACK_IMAGE).withEnvironment({ SERVICES: 'sqs' }).start(),
  ]);

  const migratorUrl = postgres.getConnectionUri();
  const ownerPool = new pg.Pool({ connectionString: migratorUrl, max: 6 });
  // Mesmo script que o compose usa no primeiro boot do Postgres.
  await ownerPool.query(await Bun.file(ROLES_SQL).text());

  const appUrl = withCredentials(migratorUrl, 'chimp_app', 'chimp_app');
  const appPool = new pg.Pool({ connectionString: appUrl, max: 6 });

  const sqsEndpoint = localstack.getConnectionUri();
  const sqs = new SQSClient({
    endpoint: sqsEndpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  return {
    migratorUrl,
    appUrl,
    ownerPool,
    appPool,
    sqsEndpoint,
    sqs,
    queueNames: {
      transactions: 'wager-transactions.fifo',
      transactionsDlq: 'wager-transactions-dlq.fifo',
      events: 'wager-events.fifo',
    },
    async sql<T>(text: string, params: unknown[] = []) {
      const result = await ownerPool.query(text, params);
      return result.rows as T[];
    },
    async stop() {
      sqs.destroy();
      await Promise.all([ownerPool.end(), appPool.end()]);
      await Promise.all([postgres.stop(), localstack.stop()]);
    },
  };
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}
