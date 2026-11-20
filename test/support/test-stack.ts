import { SQSClient } from '@aws-sdk/client-sqs';
import { LocalstackContainer } from '@testcontainers/localstack';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { QueueNames } from '../../src/messaging/infrastructure/sqs-topology';

export interface TestStack {
  databaseUrl: string;
  sqsEndpoint: string;
  sqs: SQSClient;
  queueNames: QueueNames;
  sql<T>(text: string, params?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const LOCALSTACK_IMAGE = 'localstack/localstack:4.4';

/**
 * Sobe Postgres e LocalStack reais para o arquivo de teste. Cada arquivo
 * tem a sua stack, então um teste nunca enxerga lixo de outro.
 */
export async function startTestStack(): Promise<TestStack> {
  const [postgres, localstack] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new LocalstackContainer(LOCALSTACK_IMAGE).withEnvironment({ SERVICES: 'sqs' }).start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  const sqsEndpoint = localstack.getConnectionUri();
  const sqs = new SQSClient({
    endpoint: sqsEndpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  return {
    databaseUrl,
    sqsEndpoint,
    sqs,
    queueNames: {
      transactions: 'wager-transactions.fifo',
      transactionsDlq: 'wager-transactions-dlq.fifo',
      events: 'wager-events.fifo',
    },
    async sql<T>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return result.rows as T[];
    },
    async stop() {
      sqs.destroy();
      await pool.end();
      await Promise.all([postgres.stop(), localstack.stop()]);
    },
  };
}
