import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { ensureQueues } from '../../src/messaging/infrastructure/sqs-topology';
import { startTestStack, type TestStack } from '../support/test-stack';

// Primeiro teste que encosta em infra de verdade. Se ele quebrar, nenhum
// outro teste de integração vai fazer sentido, então ele vem antes de tudo.
describe('stack local (Postgres + LocalStack em containers)', () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await startTestStack();
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  test('Postgres responde', async () => {
    const [row] = await stack.sql<{ ok: number }>('select 1 as ok');
    expect(row?.ok).toBe(1);
  });

  test('cria as filas FIFO com DLQ ligada por redrive', async () => {
    const urls = await ensureQueues(stack.sqs, stack.queueNames);
    const listed = await stack.sqs.send(new ListQueuesCommand({}));

    expect(listed.QueueUrls?.length).toBe(3);
    expect(urls.transactions).toContain('wager-transactions.fifo');
    expect(urls.transactionsDlq).toContain('wager-transactions-dlq.fifo');
    expect(urls.events).toContain('wager-events.fifo');
  });

  test('ensureQueues pode rodar de novo sem quebrar (idempotente)', async () => {
    await ensureQueues(stack.sqs, stack.queueNames);
    const listed = await stack.sqs.send(new ListQueuesCommand({}));
    expect(listed.QueueUrls?.length).toBe(3);
  });
});
