import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/shared/infrastructure/database/orm';
import { UuidV7Generator } from '../../src/shared/infrastructure/system';
import { ReprocessPendingReferences } from '../../src/wagering/application/reprocess-pending-references';
import { WagerProcessor } from '../../src/wagering/application/wager-processor';
import { ReferenceRetryPolicy } from '../../src/wagering/domain/reference-retry-policy';
import { type ApiHarness, startApiHarness } from '../support/api-harness';
import { assertLedgerInvariant } from '../support/invariants';

describe('worker de referências pendentes', () => {
  let api: ApiHarness;
  let orm: MikroORM;

  const policy = new ReferenceRetryPolicy({
    baseDelayMs: 2_000,
    maxDelayMs: 300_000,
    maxAttempts: 10,
    ttlMs: 3_600_000,
  });

  beforeAll(async () => {
    api = await startApiHarness();
    orm = await createOrm(loadConfig({ DATABASE_URL: api.stack.appUrl }));
  }, 180_000);

  afterAll(async () => {
    await orm?.close(true);
    await api?.stop();
  });

  const sweeper = () => {
    const ids = new UuidV7Generator();
    return new ReprocessPendingReferences(
      new MikroOrmUnitOfWork(orm, 2_000),
      new WagerProcessor(ids, policy),
      policy,
      { batchSize: 50 },
    );
  };

  const later = (ms: number) => new Date(Date.now() + ms);

  async function openWallet(amount = '100.00') {
    const playerId = randomUUID();
    const res = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    return { walletId: res.body.id as string, playerId };
  }

  function submit(w: { walletId: string; playerId: string }, over: Record<string, unknown>) {
    const body = {
      providerId: 'provider-a',
      externalTransactionId: `tx-${randomUUID()}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...over,
    };
    return api
      .request('POST', '/wagering/transactions', body, {
        'idempotency-key': `provider-a:${body.externalTransactionId}`,
      })
      .then((res) => ({ res, body }));
  }

  /** REFUND (ou ROLLBACK) que chega antes da BET que ele referencia. */
  async function reversalBeforeBet(kind = 'REFUND', amount = '25.00') {
    const w = await openWallet();
    const betExt = `bet-${randomUUID()}`;
    const { res } = await submit(w, {
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: betExt,
    });
    expect(res.status).toBe(202);
    return { w, betExt, reversalId: res.body.transactionId as string };
  }

  const transaction = async (id: string) =>
    (
      await api.stack.sql<{
        status: string;
        failure_code: string | null;
        reference_attempts: number;
        next_reference_check_at: Date | null;
      }>(
        `select status, failure_code, reference_attempts, next_reference_check_at
           from wager_transactions where id = $1`,
        [id],
      )
    )[0];

  const eventsFor = async (walletId: string, type: string) =>
    (
      await api.stack.sql<{ n: number }>(
        'select count(*)::int as n from outbox_messages where aggregate_id = $1 and event_type = $2',
        [walletId, type],
      )
    )[0]?.n;

  test('aplica o REFUND estacionado quando a BET chega', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet();
    await submit(w, { externalTransactionId: betExt });

    expect(await sweeper().runOnce(later(3_000))).toBe(1);

    expect((await transaction(reversalId))?.status).toBe('PROCESSED');
    const wallet = await api.request('GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance.amount).toBe('100.00');
    await assertLedgerInvariant(api.stack, w.walletId);
  });

  test('não mexe no que ainda não venceu', async () => {
    const { reversalId } = await reversalBeforeBet();
    expect(await sweeper().runOnce(new Date())).toBe(0);
    expect((await transaction(reversalId))?.reference_attempts).toBe(1);
  });

  test('referência ainda ausente: reagenda com espera maior e sem repetir o evento', async () => {
    const { w, reversalId } = await reversalBeforeBet();
    const now = later(3_000);

    await sweeper().runOnce(now);

    const t = await transaction(reversalId);
    expect(t?.status).toBe('PENDING_REFERENCE');
    expect(t?.reference_attempts).toBe(2);
    expect(t?.next_reference_check_at?.getTime()).toBe(now.getTime() + 4_000);
    expect(await eventsFor(w.walletId, 'WagerTransactionPendingReference')).toBe(1);
  });

  test('esgotou as tentativas: REJECTED com REFERENCE_NOT_FOUND e evento', async () => {
    const { w, reversalId } = await reversalBeforeBet();
    await api.stack.sql('update wager_transactions set reference_attempts = 10 where id = $1', [
      reversalId,
    ]);

    await sweeper().runOnce(later(3_000));

    expect(await transaction(reversalId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await eventsFor(w.walletId, 'WagerTransactionRejected')).toBe(1);
  });

  test('passou do TTL de 1 hora: rejeita mesmo com poucas tentativas', async () => {
    const { reversalId } = await reversalBeforeBet();
    await sweeper().runOnce(later(3_600_000 + 1_000));
    expect((await transaction(reversalId))?.failure_code).toBe('REFERENCE_NOT_FOUND');
  });

  test('referência chegou mas foi rejeitada: REFERENCE_NOT_PROCESSED', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet('ROLLBACK', '500.00');
    const { res } = await submit(w, {
      externalTransactionId: betExt,
      money: { amount: '500.00', currency: 'BRL' },
    });
    expect(res.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    await sweeper().runOnce(later(3_000));
    expect((await transaction(reversalId))?.failure_code).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('dois workers ao mesmo tempo aplicam o REFUND uma vez só', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet();
    await submit(w, { externalTransactionId: betExt });
    // Pendências que sobraram dos testes anteriores ficam para depois, para a
    // contagem medir só a disputa por esta transação.
    await api.stack.sql(
      `update wager_transactions set next_reference_check_at = now() + interval '1 day'
        where status = 'PENDING_REFERENCE' and id <> $1`,
      [reversalId],
    );

    const [a, b] = await Promise.all([
      sweeper().runOnce(later(3_000)),
      sweeper().runOnce(later(3_000)),
    ]);

    expect(a + b).toBe(1);
    const [entries] = await api.stack.sql<{ n: number }>(
      'select count(*)::int as n from wallet_ledger_entries where transaction_id = $1',
      [reversalId],
    );
    expect(entries?.n).toBe(1);
    await assertLedgerInvariant(api.stack, w.walletId);
  });
});
