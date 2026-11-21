import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createWorker, type Worker } from '../../src/bootstrap/worker';
import { ensureQueues } from '../../src/messaging/infrastructure/sqs-topology';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { startTestStack, type TestStack } from '../support/test-stack';

describe('processo worker', () => {
  let stack: TestStack;
  let worker: Worker;

  beforeAll(async () => {
    stack = await startTestStack();
    await runMigrations(stack.migratorUrl, 'up');
    await ensureQueues(stack.sqs, stack.queueNames);
    worker = await createWorker(
      loadConfig({
        DATABASE_URL: stack.appUrl,
        SQS_ENDPOINT: stack.sqsEndpoint,
        OUTBOX_POLL_MS: '50',
        LOG_LEVEL: 'silent',
      }),
    );
    worker.start();
  }, 180_000);

  afterAll(async () => {
    await worker?.stop();
    await stack?.stop();
  });

  test('publica sozinho o que aparece na outbox', async () => {
    await stack.sql(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (gen_random_uuid(), 'wallet-1', 'WalletBalanceChanged', '{"eventId":"e1"}', now(), 0)`,
    );

    const deadline = Date.now() + 10_000;
    let published = 0;
    while (Date.now() < deadline && published === 0) {
      await Bun.sleep(100);
      const [row] = await stack.sql<{ n: number }>(
        'select count(*)::int as n from outbox_messages where published_at is not null',
      );
      published = row?.n ?? 0;
    }
    expect(published).toBe(1);
  });
});
