import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Subprocess } from 'bun';
import { ensureQueues, type QueueUrls } from '../../src/messaging/infrastructure/sqs-topology';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { assertLedgerInvariant } from '../support/invariants';
import { startTestStack, type TestStack } from '../support/test-stack';
import { startFleet } from './instances';

/**
 * Recuperação com processos de verdade morrendo no pior momento. Nada aqui é
 * simulado em memória: o worker e a API rodam como processos separados e são
 * derrubados no meio do trabalho.
 */
describe('recuperação após falhas', () => {
  let stack: TestStack;
  let queues: QueueUrls;

  beforeAll(async () => {
    stack = await startTestStack();
    await runMigrations(stack.migratorUrl, 'up');
    await stack.sql(`insert into providers (id, currencies) values ('provider-a', '{BRL}')`);
    // Visibilidade curta para a reentrega depois da queda não demorar 30s.
    queues = await ensureQueues(stack.sqs, stack.queueNames, { visibilityTimeoutSeconds: 2 });
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  function spawnWorker(extraEnv: Record<string, string> = {}): Subprocess {
    return Bun.spawn(['bun', 'src/main.worker.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: stack.appUrl,
        SQS_ENDPOINT: stack.sqsEndpoint,
        WORKER_HTTP_PORT: '0',
        LOG_LEVEL: 'silent',
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_RETRY_BASE_SECONDS: '0',
        OUTBOX_POLL_MS: '50',
        ...extraEnv,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
  }

  async function exitCode(child: Subprocess, timeoutMs = 20_000): Promise<number | null> {
    const timeout = Bun.sleep(timeoutMs).then(() => 'timeout' as const);
    const result = await Promise.race([child.exited, timeout]);
    if (result === 'timeout') {
      child.kill('SIGKILL');
      return null;
    }
    return result;
  }

  async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await Bun.sleep(100);
    }
    return false;
  }

  async function zeroWallet() {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await stack.sql(
      `insert into wallets (id, player_id, currency, balance, version, ledger_sequence, ledger_head_hash,
         created_at, updated_at)
       values ($1::uuid, $2, 'BRL', 0, 1, 0, encode(sha256(('genesis:' || $1::text)::bytea), 'hex'), now(), now())`,
      [walletId, playerId],
    );
    return { walletId, playerId };
  }

  const queueDepth = async (url: string) => {
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

  test('worker morre depois do commit e antes do ack: a reentrega não duplica o crédito', async () => {
    const { walletId, playerId } = await zeroWallet();
    const ext = `win-${randomUUID()}`;
    await stack.sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.transactions,
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

    const crashing = spawnWorker({ FAULT_INJECTION: 'crash-after-commit' });
    expect(await exitCode(crashing)).toBe(137);

    // O commit aconteceu, mas a mensagem continua na fila (não houve ack).
    const [afterCrash] = await stack.sql<{ balance: string }>(
      'select balance::text from wallets where id = $1',
      [walletId],
    );
    expect(afterCrash?.balance).toBe('15.00');
    expect(await queueDepth(queues.transactions)).toBe(1);

    const healthy = spawnWorker();
    try {
      expect(await until(async () => (await queueDepth(queues.transactions)) === 0)).toBe(true);
    } finally {
      healthy.kill('SIGKILL');
      await healthy.exited;
    }

    const [final] = await stack.sql<{ balance: string; entries: number }>(
      `select w.balance::text,
              (select count(*)::int from wallet_ledger_entries e where e.wallet_id = w.id) as entries
         from wallets w where w.id = $1`,
      [walletId],
    );
    expect(final).toEqual({ balance: '15.00', entries: 1 });
    await assertLedgerInvariant(stack, walletId);
  }, 60_000);

  test('relay morre com eventos reservados: outro processo publica depois do lease', async () => {
    await stack.sql('delete from outbox_messages');
    await stack.sql(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (gen_random_uuid(), 'wallet-x', 'WalletBalanceChanged', '{"eventId":"e-1"}', now(), 0)`,
    );

    const crashing = spawnWorker({
      FAULT_INJECTION: 'crash-after-claim',
      OUTBOX_LEASE_MS: '1500',
    });
    expect(await exitCode(crashing)).toBe(137);
    const [leased] = await stack.sql<{ leased: boolean; published: boolean }>(
      `select lease_until is not null as leased, published_at is not null as published
         from outbox_messages`,
    );
    expect(leased).toEqual({ leased: true, published: false });

    const healthy = spawnWorker();
    try {
      const published = await until(async () => {
        const [row] = await stack.sql<{ published: boolean }>(
          'select published_at is not null as published from outbox_messages',
        );
        return row?.published === true;
      });
      expect(published).toBe(true);
    } finally {
      healthy.kill('SIGKILL');
      await healthy.exited;
    }
  }, 60_000);

  test('instâncias da API derrubadas com kill -9 no meio da carga: tudo fecha no final', async () => {
    const fleet = await startFleet(stack, 3);
    try {
      const wallets: { walletId: string; playerId: string }[] = [];
      for (let i = 0; i < 4; i++) {
        const playerId = randomUUID();
        const res = await fetch(`${fleet.instances[0]?.url}/wallets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId, initialBalance: { amount: '300.00', currency: 'BRL' } }),
        });
        wallets.push({ walletId: ((await res.json()) as { id: string }).id, playerId });
      }

      let unexpected = 0;
      // Cada operação insiste até ter uma resposta do contrato. Se a instância
      // morreu no meio, tenta em outra: pode ter comitado antes de morrer, e
      // aí a nova tentativa volta como replay, que é exatamente o que importa.
      const send = async (i: number) => {
        const w = wallets[i % wallets.length] as { walletId: string; playerId: string };
        const ext = `op-${i}-${randomUUID()}`;
        const body = JSON.stringify({
          providerId: 'provider-a',
          externalTransactionId: ext,
          playerId: w.playerId,
          walletId: w.walletId,
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: i % 3 === 0 ? 'WIN' : 'BET',
          money: { amount: '3.00', currency: 'BRL' },
        });
        for (let attempt = 0; attempt < 50; attempt++) {
          const instance = fleet.instances[(i + attempt) % fleet.instances.length];
          try {
            const res = await fetch(`${instance?.url}/wagering/transactions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': `provider-a:${ext}`,
              },
              body,
            });
            if (res.status === 503) continue;
            if (![200, 201, 422].includes(res.status)) unexpected++;
            return;
          } catch {
            await Bun.sleep(50);
          }
        }
        unexpected++;
      };

      const load = (async () => {
        for (let i = 0; i < 240; i += 12) {
          await Promise.all(Array.from({ length: 12 }, (_, k) => send(i + k)));
        }
      })();
      const chaos = (async () => {
        await Bun.sleep(300);
        await fleet.kill(0);
        await Bun.sleep(300);
        await fleet.kill(1);
        await fleet.restart(0);
        await Bun.sleep(300);
        await fleet.restart(1);
      })();
      await Promise.all([load, chaos]);

      expect(unexpected).toBe(0);
      for (const w of wallets) {
        await assertLedgerInvariant(stack, w.walletId);
        const res = await fetch(`${fleet.instances[2]?.url}/wallets/${w.walletId}/reconciliation`, {
          method: 'POST',
        });
        expect(((await res.json()) as { consistent: boolean }).consistent).toBe(true);
      }
    } finally {
      await fleet.stop();
    }
  }, 120_000);

  // No Windows o Bun não entrega SIGTERM como sinal tratável (ele mata o
  // processo direto), então este caso roda só em Linux/macOS, como no CI.
  test.skipIf(process.platform === 'win32')(
    'SIGTERM no worker: termina o que está em andamento e sai com código 0',
    async () => {
      const worker = spawnWorker();
      await Bun.sleep(1_500);
      worker.kill('SIGTERM');
      expect(await exitCode(worker, 15_000)).toBe(0);
    },
    30_000,
  );
});
