import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ensureQueues, type QueueUrls } from '../../src/messaging/infrastructure/sqs-topology';
import { WagerConsumer } from '../../src/messaging/infrastructure/wager-consumer';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-unit-of-work';
import { createOrm, ENTITY_SCHEMAS } from '../../src/shared/infrastructure/database/orm';
import { SystemClock, UuidV7Generator } from '../../src/shared/infrastructure/system';
import { SubmitWagerTransaction } from '../../src/wagering/application/submit-wager-transaction';
import { WagerProcessor } from '../../src/wagering/application/wager-processor';
import { ReferenceRetryPolicy } from '../../src/wagering/domain/reference-retry-policy';
import { OpenWallet } from '../../src/wallet/application/open-wallet';
import { startTestStack, type TestStack } from '../support/test-stack';

describe('consumidor SQS de transações', () => {
  let stack: TestStack;
  let orm: MikroORM;
  let queues: QueueUrls;
  let submit: SubmitWagerTransaction;
  let openWallet: OpenWallet;

  const retry = new ReferenceRetryPolicy({
    baseDelayMs: 2_000,
    maxDelayMs: 300_000,
    maxAttempts: 10,
    ttlMs: 3_600_000,
  });
  const processor = new WagerProcessor(new UuidV7Generator(), retry);

  beforeAll(async () => {
    stack = await startTestStack();
    await runMigrations(stack.migratorUrl, 'up');
    await stack.sql(`insert into providers (id, currencies) values ('provider-a', '{BRL}')`);
    queues = await ensureQueues(stack.sqs, stack.queueNames);
    orm = await createOrm(loadConfig({ DATABASE_URL: stack.appUrl }));
    const uow = new MikroOrmUnitOfWork(orm, 2_000);
    submit = new SubmitWagerTransaction(uow, new UuidV7Generator(), new SystemClock(), processor);
    openWallet = new OpenWallet(uow, new UuidV7Generator(), new SystemClock());
  }, 180_000);

  afterAll(async () => {
    await orm?.close(true);
    await stack?.stop();
  });

  beforeEach(async () => {
    await stack.sqs.send(new PurgeQueueCommand({ QueueUrl: queues.transactions }));
    await stack.sqs.send(new PurgeQueueCommand({ QueueUrl: queues.transactionsDlq }));
  });

  const consumer = (useCase = submit) =>
    new WagerConsumer(stack.sqs, queues, useCase, {
      consumerName: 'wager-consumer',
      waitTimeSeconds: 1,
      retryBaseSeconds: 0, // nos testes a reentrega é imediata
    });

  async function wallet(amount = '100.00') {
    const playerId = randomUUID();
    const w = await openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' } });
    return { walletId: w.id, playerId };
  }

  function message(w: { walletId: string; playerId: string }, over: Record<string, unknown> = {}) {
    const ext = `tx-${randomUUID()}`;
    return {
      messageId: `msg-${randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: ext,
        idempotencyKey: `provider-a:${ext}`,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        ...over,
      },
    };
  }

  // Deduplicação do SQS desligada de propósito (id aleatório), para o teste
  // conseguir entregar a mesma mensagem duas vezes e provar que a inbox segura.
  const send = (body: unknown, group = 'g1') =>
    stack.sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.transactions,
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: group,
        MessageDeduplicationId: randomUUID(),
      }),
    );

  const approxCount = async (url: string) => {
    const { Attributes } = await stack.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  };

  const transactionStatus = async (key: string) =>
    (
      await stack.sql<{ status: string; failure_code: string | null }>(
        'select status, failure_code from wager_transactions where idempotency_key = $1',
        [key],
      )
    )[0];

  test('processa a mensagem, grava a inbox e só então apaga da fila', async () => {
    const w = await wallet();
    const msg = message(w);
    await send(msg);

    expect(await consumer().pollOnce()).toBe(1);

    expect(await transactionStatus(msg.data.idempotencyKey)).toEqual({
      status: 'PROCESSED',
      failure_code: null,
    });
    const [inbox] = await stack.sql<{ n: number }>(
      'select count(*)::int as n from inbox_messages where message_id = $1',
      [msg.messageId],
    );
    expect(inbox?.n).toBe(1);
    expect(await approxCount(queues.transactions)).toBe(0);
  });

  test('a mesma mensagem entregue duas vezes aplica o efeito uma vez só', async () => {
    const w = await wallet('100.00');
    const msg = message(w);
    await send(msg);
    await send(msg);

    const c = consumer();
    let handled = 0;
    for (let i = 0; i < 4 && handled < 2; i++) handled += await c.pollOnce();

    expect(handled).toBe(2);
    const [row] = await stack.sql<{ balance: string }>(
      'select balance from wallets where id = $1',
      [w.walletId],
    );
    expect(row?.balance).toBe('75.00');
    expect(await approxCount(queues.transactions)).toBe(0);
  });

  test('rejeição de negócio é final: grava REJECTED e confirma a mensagem', async () => {
    const w = await wallet('10.00');
    const msg = message(w, { money: { amount: '50.00', currency: 'BRL' } });
    await send(msg);

    await consumer().pollOnce();

    expect(await transactionStatus(msg.data.idempotencyKey)).toEqual({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(await approxCount(queues.transactions)).toBe(0);
    expect(await approxCount(queues.transactionsDlq)).toBe(0);
  });

  test.each([
    ['JSON quebrado', '{"messageId": "x", '],
    [
      'type desconhecido',
      { messageId: 'm1', type: 'Outro', occurredAt: new Date().toISOString(), data: {} },
    ],
    ['OPENING pela fila', 'OPENING'],
    ['valor com notação científica', 'SCI'],
  ])('mensagem permanentemente inválida (%s) vai direto para a DLQ', async (_n, body) => {
    const w = await wallet();
    const payload =
      body === 'OPENING'
        ? message(w, { kind: 'OPENING' })
        : body === 'SCI'
          ? message(w, { money: { amount: '1e3', currency: 'BRL' } })
          : body;
    await send(payload);

    await consumer().pollOnce();

    expect(await approxCount(queues.transactions)).toBe(0);
    expect(await approxCount(queues.transactionsDlq)).toBe(1);
  });

  test('falha transitória não confirma: reentrega até dar certo', async () => {
    const w = await wallet('100.00');
    const msg = message(w);
    await send(msg);

    // ORM apontando para uma porta onde não há Postgres: erro real de conexão.
    const brokenOrm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: 'postgres://chimp_app:chimp_app@127.0.0.1:1/chimp',
      entities: ENTITY_SCHEMAS,
      connect: false,
      pool: { min: 0, max: 1, acquireTimeoutMillis: 2_000 },
    });
    const broken = new SubmitWagerTransaction(
      new MikroOrmUnitOfWork(brokenOrm, 2_000),
      new UuidV7Generator(),
      new SystemClock(),
      processor,
    );

    expect(await consumer(broken).pollOnce()).toBe(1);
    expect(await transactionStatus(msg.data.idempotencyKey)).toBeUndefined();
    expect(await approxCount(queues.transactions)).toBe(1);

    // banco "voltou": o consumidor saudável processa a mesma mensagem.
    expect(await consumer().pollOnce()).toBe(1);
    expect((await transactionStatus(msg.data.idempotencyKey))?.status).toBe('PROCESSED');
    await brokenOrm.close(true);
  });

  test('falha transitória insistente vai para a DLQ pelo redrive depois de 5 entregas', async () => {
    const w = await wallet();
    await send(message(w));
    const brokenOrm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: 'postgres://chimp_app:chimp_app@127.0.0.1:1/chimp',
      entities: ENTITY_SCHEMAS,
      connect: false,
      pool: { min: 0, max: 1, acquireTimeoutMillis: 2_000 },
    });
    const broken = consumer(
      new SubmitWagerTransaction(
        new MikroOrmUnitOfWork(brokenOrm, 2_000),
        new UuidV7Generator(),
        new SystemClock(),
        processor,
      ),
    );

    for (let i = 0; i < 8; i++) await broken.pollOnce();

    expect(await approxCount(queues.transactions)).toBe(0);
    expect(await approxCount(queues.transactionsDlq)).toBe(1);
    await brokenOrm.close(true);
  }, 60_000);

  // Abortar o long polling do lado do cliente não cancela o receive no
  // servidor: a requisição abandonada ainda recebe as mensagens que chegam,
  // e elas ficam invisíveis por um visibility timeout inteiro. Por isso o
  // stop espera o receive atual voltar e devolve o que veio nele.
  test('stop durante o long polling devolve na hora o que chegou e não perde mensagem', async () => {
    const w = await wallet('1000.00');
    const messages = Array.from({ length: 6 }, () => message(w));
    const stopping = new WagerConsumer(stack.sqs, queues, submit, {
      consumerName: 'wager-consumer',
      waitTimeSeconds: 2,
      retryBaseSeconds: 0,
    });

    const startedAt = Date.now();
    const polling = stopping.pollOnce();
    await Bun.sleep(100);
    stopping.stop();
    for (const m of messages) await send(m, w.walletId);
    await polling;
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    const c = consumer();
    let handled = 0;
    for (let i = 0; i < 10 && handled < 6; i++) handled += await c.pollOnce();
    expect(handled).toBe(6);

    const [row] = await stack.sql<{ balance: string }>(
      'select balance from wallets where id = $1',
      [w.walletId],
    );
    expect(row?.balance).toBe('850.00');
  }, 30_000);

  test('mensagens da mesma carteira são aplicadas na ordem da fila', async () => {
    const w = await wallet('100.00');
    const bet = message(w, { money: { amount: '40.00', currency: 'BRL' } });
    const refund = message(w, {
      kind: 'REFUND',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await send(bet, w.walletId);
    await send(refund, w.walletId);

    const c = consumer();
    let handled = 0;
    for (let i = 0; i < 4 && handled < 2; i++) handled += await c.pollOnce();

    // Se o REFUND tivesse passado na frente, ele ficaria PENDING_REFERENCE.
    expect((await transactionStatus(refund.data.idempotencyKey))?.status).toBe('PROCESSED');
    expect(await approxCount(queues.transactions)).toBe(0);
  });
});
