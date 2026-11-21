import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
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
    await stack.sqs.send(new PurgeQueueCommand({ QueueUrl: queues.events }));
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

  const relay = (
    publisher: EventPublisher,
    aggregatesPerRound = 50,
    onOrderAnomaly?: (count: number) => void,
  ) =>
    new OutboxRelay(orm, publisher, {
      aggregatesPerRound,
      leaseMs: 30_000,
      publishBatchSize: 10,
      onOrderAnomaly,
    });

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

  const idsInOrder = async (aggregateId: string) =>
    (
      await stack.sql<{ id: string }>(
        'select id from outbox_messages where aggregate_id = $1 order by occurred_at, id',
        [aggregateId],
      )
    ).map((r) => r.id);

  test('falha num evento segura os seguintes da mesma carteira', async () => {
    await seed(3, 'wallet-ordem');
    const [first, second, third] = await idsInOrder('wallet-ordem');
    const failingFirst: EventPublisher = {
      async publish(events) {
        if (events.some((e) => e.id === first)) return { published: [], failed: [first ?? ''] };
        return realPublisher().publish(events);
      },
    };

    expect(await relay(failingFirst).runOnce(plus(1_000))).toBe(0);
    const rows = await stack.sql<{ id: string; published_at: Date | null; attempts: number }>(
      'select id, published_at, attempts from outbox_messages order by occurred_at, id',
    );
    expect(rows.map((r) => [r.published_at === null, r.attempts])).toEqual([
      [true, 1],
      [true, 0],
      [true, 0],
    ]);

    expect(await relay(realPublisher()).runOnce(plus(2_000))).toBe(3);
    // A fila FIFO entrega na ordem em que o relay publicou.
    const delivered = await drainEvents();
    const eventIdsInOrder = (
      await stack.sql<{ event_id: string }>(
        `select payload->>'eventId' as event_id from outbox_messages
          where id = any($1::uuid[]) order by occurred_at, id`,
        [[first, second, third]],
      )
    ).map((r) => r.event_id);
    expect(delivered).toEqual(eventIdsInOrder);
  });

  test('com dois relays, cada carteira é publicada na ordem dos seus eventos', async () => {
    const wallets = Array.from({ length: 10 }, (_, i) => `wallet-${i}`);
    for (const w of wallets) await seed(20, w);
    const publishLog: string[] = [];
    const logging = (): EventPublisher => {
      const real = realPublisher();
      return {
        async publish(events) {
          const outcome = await real.publish(events);
          publishLog.push(...outcome.published);
          return outcome;
        },
      };
    };

    const a = relay(logging(), 3);
    const b = relay(logging(), 3);
    let total = 0;
    for (let round = 0; round < 30 && total < 200; round++) {
      const [x, y] = await Promise.all([a.runOnce(plus(1_000)), b.runOnce(plus(1_000))]);
      total += x + y;
    }

    expect(total).toBe(200);
    for (const w of wallets) {
      const expected = await idsInOrder(w);
      expect(publishLog.filter((id) => expected.includes(id))).toEqual(expected);
    }
    await drainEvents();
  }, 60_000);

  // É assim que o worker roda: várias vias chamando o mesmo relay ao mesmo
  // tempo. Cada via reivindica carteiras diferentes; dentro de uma carteira
  // a ordem não pode mudar e nenhum evento pode sair duas vezes.
  test('várias vias no mesmo relay mantêm a ordem e não repetem evento', async () => {
    const wallets = Array.from({ length: 12 }, (_, i) => `wallet-via-${i}`);
    for (const w of wallets) await seed(15, w);
    const publishLog: string[] = [];
    const real = realPublisher();
    const shared = relay(
      {
        async publish(events) {
          const outcome = await real.publish(events);
          publishLog.push(...outcome.published);
          return outcome;
        },
      },
      2,
    );

    let total = 0;
    for (let round = 0; round < 40 && total < 180; round++) {
      const lanes = await Promise.all(Array.from({ length: 4 }, () => shared.runOnce(plus(1_000))));
      total += lanes.reduce((sum, n) => sum + n, 0);
    }

    expect(total).toBe(180);
    expect(new Set(publishLog).size).toBe(publishLog.length);
    for (const w of wallets) {
      const expected = await idsInOrder(w);
      expect(publishLog.filter((id) => expected.includes(id))).toEqual(expected);
    }
    await drainEvents();
  }, 60_000);

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

  test('publica em lotes de até 10 por carteira, na ordem dos eventos', async () => {
    await seed(25, 'wallet-lote');
    const calls: number[] = [];
    const real = realPublisher();
    const counting: EventPublisher = {
      async publish(events) {
        calls.push(events.length);
        return real.publish(events);
      },
    };

    expect(await relay(counting).runOnce(plus(1_000))).toBe(25);
    expect(calls).toEqual([10, 10, 5]);

    const eventIdsInOrder = (
      await stack.sql<{ event_id: string }>(
        `select payload->>'eventId' as event_id from outbox_messages
          where aggregate_id = 'wallet-lote' order by occurred_at, id`,
      )
    ).map((r) => r.event_id);
    expect(await drainEvents()).toEqual(eventIdsInOrder);
  });

  test('falha no meio do lote: o aceito conta como publicado e a anomalia de ordem é sinalizada', async () => {
    await seed(10, 'wallet-anomalia');
    const ids = await idsInOrder('wallet-anomalia');
    const second = ids[1] ?? '';
    const real = realPublisher();
    // O SQS recusou só o segundo evento do lote e aceitou os outros.
    const partial: EventPublisher = {
      async publish(events) {
        const outcome = await real.publish(events.filter((e) => e.id !== second));
        return { published: outcome.published, failed: [...outcome.failed, second] };
      },
    };
    const anomalies: number[] = [];

    expect(await relay(partial, 50, (n) => anomalies.push(n)).runOnce(plus(1_000))).toBe(9);

    const rows = await stack.sql<{ id: string; published: boolean; attempts: number }>(
      `select id, published_at is not null as published, attempts from outbox_messages
        where aggregate_id = 'wallet-anomalia' order by occurred_at, id`,
    );
    expect(rows.filter((r) => !r.published).map((r) => [r.id, r.attempts])).toEqual([[second, 1]]);
    expect(anomalies).toEqual([8]);
    await drainEvents();
  });
});
