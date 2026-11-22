import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createWorker, type Worker } from '../../src/bootstrap/worker';
import { ensureQueues } from '../../src/messaging/infrastructure/sqs-topology';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { assertLedgerInvariantForAllWallets } from '../support/invariants';
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
        SQS_WAIT_TIME_SECONDS: '1',
        WORKER_HTTP_PORT: '0',
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
  test('consome a fila de ponta a ponta: mensagem → transação aplicada → evento publicado', async () => {
    await stack.sql(
      `insert into providers (id, currencies) values ('provider-a', '{BRL}') on conflict do nothing`,
    );
    const walletId = randomUUID();
    const playerId = randomUUID();
    await stack.sql(
      `insert into wallets (id, player_id, currency, balance, version, ledger_head_hash, created_at, updated_at)
       values ($1::uuid, $2, 'BRL', 0, 1, encode(sha256(('genesis:' || $1::text)::bytea), 'hex'), now(), now())`,
      [walletId, playerId],
    );
    const ext = `tx-${randomUUID()}`;
    await stack.sqs.send(
      new SendMessageCommand({
        QueueUrl: (await ensureQueues(stack.sqs, stack.queueNames)).transactions,
        MessageGroupId: walletId,
        MessageDeduplicationId: ext,
        MessageBody: JSON.stringify({
          messageId: `msg-${ext}`,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId: ext,
            idempotencyKey: `provider-a:${ext}`,
            playerId,
            walletId,
            roundId: 'round-1',
            gameId: 'fortune-chimp',
            kind: 'WIN',
            money: { amount: '15.00', currency: 'BRL' },
          },
        }),
      }),
    );

    const deadline = Date.now() + 15_000;
    let row: { balance: string; published: number } | undefined;
    while (Date.now() < deadline) {
      [row] = await stack.sql<{ balance: string; published: number }>(
        `select w.balance::text as balance,
                (select count(*)::int from outbox_messages
                  where aggregate_id = $1::text and published_at is not null) as published
           from wallets w where w.id = $1::uuid`,
        [walletId],
      );
      if (row?.balance === '15.00' && row.published === 2) break;
      await Bun.sleep(100);
    }
    expect(row).toEqual({ balance: '15.00', published: 2 });
  }, 30_000);

  test('expõe health checks e métricas numa porta própria', async () => {
    const live = await fetch(`${worker.url}/health/live`);
    expect(live.status).toBe(200);

    const ready = await fetch(`${worker.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });

    const metrics = await (await fetch(`${worker.url}/metrics`)).text();
    expect(metrics).toMatch(/^outbox_lag_seconds \d/m);
    expect(metrics).toMatch(/^outbox_published_total [1-9]/m);
    expect(metrics).toMatch(/^wager_consumer_messages_total\{outcome="acked"\} [1-9]/m);
    expect(metrics).toMatch(/^wager_transactions_total\{[^}]*source="sqs"[^}]*\} [1-9]/m);
  });

  test('invariante final: em toda carteira, saldo igual ao reconstruído pelo ledger', async () => {
    expect(await assertLedgerInvariantForAllWallets(stack)).toBeGreaterThan(0);
  });
});
