import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import {
  type EventPublisher,
  SqsEventPublisher,
} from '../../src/messaging/infrastructure/event-publisher';
import { OutboxRelay } from '../../src/messaging/infrastructure/outbox-relay';
import { ensureQueues, type QueueUrls } from '../../src/messaging/infrastructure/sqs-topology';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/shared/infrastructure/database/orm';
import { startTestStack, type TestStack } from '../support/test-stack';

describe('relay da outbox', () => {
  let stack: TestStack;
  let orm: MikroORM;
  let queues: QueueUrls;

  beforeAll(async () => {
    stack = await startTestStack();
    await runMigrations(stack.migratorUrl, 'up');
    queues = await ensureQueues(stack.sqs, stack.queueNames);
    orm = await createOrm(loadConfig({ DATABASE_URL: stack.appUrl }));
  }, 180_000);

  afterAll(async () => {
    await orm?.close(true);
    await stack?.stop();
  });

  beforeEach(async () => {
    await stack.sql('delete from outbox_messages');
  });

  const t0 = new Date('2026-11-20T12:00:00.000Z');
  const plus = (ms: number) => new Date(t0.getTime() + ms);

  async function seed(count: number, aggregateId = 'wallet-1') {
    await stack.sql(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       select gen_random_uuid(), $1, 'WalletBalanceChanged',
              jsonb_build_object('eventId', gen_random_uuid(), 'n', g), $2::timestamptz + (g || ' ms')::interval, 0
         from generate_series(1, $3) g`,
      [aggregateId, t0.toISOString(), count],
    );
  }

  const relay = (publisher: EventPublisher, batchSize = 50) =>
    new OutboxRelay(orm, publisher, { batchSize, leaseMs: 30_000 });

  const realPublisher = () => new SqsEventPublisher(stack.sqs, queues.events);

  async function drainEvents(): Promise<string[]> {
    const ids: string[] = [];
    for (let empty = 0; empty < 2; ) {
      const { Messages = [] } = await stack.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.events,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
        }),
      );
      if (Messages.length === 0) empty++;
      for (const m of Messages) {
        ids.push(JSON.parse(m.Body ?? '{}').eventId);
        await stack.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queues.events,
            ReceiptHandle: m.ReceiptHandle,
          }),
        );
      }
    }
    return ids;
  }

  test('publica o evento pendente no SQS e marca como publicado', async () => {
    await seed(1);
    const published = await relay(realPublisher()).runOnce(plus(1_000));

    expect(published).toBe(1);
    const [row] = await stack.sql<{ published_at: Date | null; lease_until: Date | null }>(
      'select published_at, lease_until from outbox_messages',
    );
    expect(row?.published_at).not.toBeNull();
    expect(row?.lease_until).toBeNull();
    expect(await drainEvents()).toHaveLength(1);
  });

  test('dois relays concorrentes nunca publicam o mesmo evento', async () => {
    await seed(200, 'wallet-a');
    const seenBy: Record<string, string[]> = { a: [], b: [] };
    const spying = (name: string): EventPublisher => {
      const real = realPublisher();
      return {
        async publish(messages) {
          seenBy[name]?.push(...messages.map((m) => m.id));
          return real.publish(messages);
        },
      };
    };

    const a = relay(spying('a'), 20);
    const b = relay(spying('b'), 20);
    let total = 0;
    for (let round = 0; round < 20; round++) {
      const [x, y] = await Promise.all([a.runOnce(plus(1_000)), b.runOnce(plus(1_000))]);
      total += x + y;
      if (x + y === 0) break;
    }

    expect(total).toBe(200);
    const overlap = seenBy.a?.filter((id) => seenBy.b?.includes(id)) ?? [];
    expect(overlap).toEqual([]);
    const [{ pending }] = (await stack.sql<{ pending: number }>(
      'select count(*)::int as pending from outbox_messages where published_at is null',
    )) as [{ pending: number }];
    expect(pending).toBe(0);
    expect(new Set(await drainEvents()).size).toBe(200);
  });

  test('falha no SQS agenda nova tentativa com backoff e libera o lease', async () => {
    await seed(1);
    const broken = new SqsEventPublisher(stack.sqs, `${queues.events}-nao-existe`);
    const published = await relay(broken).runOnce(plus(1_000));

    expect(published).toBe(0);
    const [row] = await stack.sql<{
      attempts: number;
      next_attempt_at: Date;
      published_at: Date | null;
      lease_until: Date | null;
    }>('select attempts, next_attempt_at, published_at, lease_until from outbox_messages');
    expect(row?.attempts).toBe(1);
    expect(row?.published_at).toBeNull();
    expect(row?.lease_until).toBeNull();
    expect(row?.next_attempt_at.getTime()).toBe(plus(2_000).getTime());

    // antes do horário agendado ninguém tenta de novo; depois, publica.
    expect(await relay(realPublisher()).runOnce(plus(1_500))).toBe(0);
    expect(await relay(realPublisher()).runOnce(plus(2_000))).toBe(1);
  });

  test('processo que morreu segurando o lease: outro assume depois que ele expira', async () => {
    await seed(1);
    // Simulo o processo morto: reivindicou o lote (lease gravado) e sumiu.
    await stack.sql(`update outbox_messages set lease_until = $1`, [plus(31_000).toISOString()]);

    expect(await relay(realPublisher()).runOnce(plus(5_000))).toBe(0);
    expect(await relay(realPublisher()).runOnce(plus(31_001))).toBe(1);
  });

  test('evento de transação que deu rollback nunca existe na outbox', async () => {
    const uow = new MikroOrmUnitOfWork(orm, 2_000);
    const fakeEvent = {
      eventId: randomUUID(),
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-z',
      occurredAt: t0,
      toJSON: () => ({ eventId: 'x' }),
    };
    await expect(
      uow.run(async (tx) => {
        await tx.outbox.enqueue([OutboxMessage.enqueue(fakeEvent as never)]);
        throw new Error('falha depois de gravar o evento');
      }),
    ).rejects.toThrow('falha depois de gravar o evento');

    expect(await relay(realPublisher()).runOnce(plus(1_000))).toBe(0);
  });
});
