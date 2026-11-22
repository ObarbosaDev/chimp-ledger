import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../src/shared/application/ports';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/shared/infrastructure/database/orm';
import { SystemClock, UuidV7Generator } from '../../src/shared/infrastructure/system';
import { ReprocessPendingReferences } from '../../src/wagering/application/reprocess-pending-references';
import type { WagerObserver, WagerOutcome } from '../../src/wagering/application/wager-observer';
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

  const fixedClock = (at: Date): Clock => ({ now: () => at });

  const reprocessor = (
    opts: {
      clock?: Clock;
      lockTimeoutMs?: number;
      onError?: (id: string, e: unknown) => void;
      observer?: WagerObserver;
    } = {},
  ) =>
    new ReprocessPendingReferences(
      new MikroOrmUnitOfWork(orm, opts.lockTimeoutMs ?? 2_000),
      new WagerProcessor(new UuidV7Generator(), policy),
      policy,
      opts.clock ?? new SystemClock(),
      { batchSize: 50, onError: opts.onError, observer: opts.observer },
    );

  // Rodada em que o relógio "de processamento" é o mesmo instante do lote.
  const reprocessAt = (at: Date) => reprocessor({ clock: fixedClock(at) }).runOnce(at);

  const later = (ms: number) => new Date(Date.now() + ms);

  async function openWallet(amount = '100.00') {
    const playerId = randomUUID();
    const res = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    return { walletId: res.body.id as string, playerId };
  }

  function submit(
    w: { walletId: string; playerId: string },
    over: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
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
        'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
        ...headers,
      })
      .then((res) => ({ res, body }));
  }

  /** REFUND (ou ROLLBACK) que chega antes da BET que ele referencia. */
  async function reversalBeforeBet(kind = 'REFUND', amount = '25.00', providerId = 'provider-a') {
    const w = await openWallet();
    const betExt = `bet-${randomUUID()}`;
    const { res } = await submit(w, {
      providerId,
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

    expect(await reprocessAt(later(3_000))).toBe(1);

    expect((await transaction(reversalId))?.status).toBe('PROCESSED');
    const wallet = await api.request('GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance.amount).toBe('100.00');
    await assertLedgerInvariant(api.stack, w.walletId);
  });

  test('não mexe no que ainda não venceu', async () => {
    const { reversalId } = await reversalBeforeBet();
    expect(await reprocessAt(new Date())).toBe(0);
    expect((await transaction(reversalId))?.reference_attempts).toBe(1);
  });

  test('referência ainda ausente: reagenda com espera maior e sem repetir o evento', async () => {
    const { w, reversalId } = await reversalBeforeBet();
    const now = later(3_000);

    await reprocessAt(now);

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

    await reprocessAt(later(3_000));

    expect(await transaction(reversalId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await eventsFor(w.walletId, 'WagerTransactionRejected')).toBe(1);
  });

  test('passou do TTL de 1 hora: rejeita mesmo com poucas tentativas', async () => {
    const { reversalId } = await reversalBeforeBet();
    await reprocessAt(later(3_600_000 + 1_000));
    expect((await transaction(reversalId))?.failure_code).toBe('REFERENCE_NOT_FOUND');
  });

  test('referência chegou mas foi rejeitada: REFERENCE_NOT_PROCESSED', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet('ROLLBACK', '500.00');
    const { res } = await submit(w, {
      externalTransactionId: betExt,
      money: { amount: '500.00', currency: 'BRL' },
    });
    expect(res.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    await reprocessAt(later(3_000));
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

    const [a, b] = await Promise.all([reprocessAt(later(3_000)), reprocessAt(later(3_000))]);

    expect(a + b).toBe(1);
    const [entries] = await api.stack.sql<{ n: number }>(
      'select count(*)::int as n from wallet_ledger_entries where transaction_id = $1',
      [reversalId],
    );
    expect(entries?.n).toBe(1);
    await assertLedgerInvariant(api.stack, w.walletId);
  });

  // ---- casos de borda do reprocessamento ----------------------------------

  /** Deixa só as pendências citadas vencidas, para a rodada medir só elas. */
  const onlyDue = (ids: string[]) =>
    api.stack.sql(
      `update wager_transactions set next_reference_check_at = now() + interval '1 day'
        where status = 'PENDING_REFERENCE' and not (id = any($1::uuid[]))`,
      [ids],
    );

  test('uma pendência que falha não trava o resto do lote', async () => {
    const blocked = await reversalBeforeBet();
    await submit(blocked.w, { externalTransactionId: blocked.betExt });
    const free = await reversalBeforeBet();
    await submit(free.w, { externalTransactionId: free.betExt });
    await onlyDue([blocked.reversalId, free.reversalId]);

    // Outra conexão segura o lock da primeira carteira do lote.
    const holder = await api.stack.ownerPool.connect();
    await holder.query('begin');
    await holder.query('select id from wallets where id = $1 for update', [blocked.w.walletId]);

    const errors: string[] = [];
    try {
      const at = later(3_000);
      const handled = await reprocessor({
        clock: fixedClock(at),
        lockTimeoutMs: 300,
        onError: (id) => errors.push(id),
      }).runOnce(at);

      expect(handled).toBe(1);
      expect(errors).toEqual([blocked.reversalId]);
      expect((await transaction(free.reversalId))?.status).toBe('PROCESSED');
      expect((await transaction(blocked.reversalId))?.status).toBe('PENDING_REFERENCE');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });

  test('usa o relógio do momento do processamento, não o instante em que o lote começou', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet();
    await submit(w, { externalTransactionId: betExt });
    await onlyDue([reversalId]);
    const batchStartedAt = later(3_000);
    const processedAt = later(60_000);

    await reprocessor({ clock: fixedClock(processedAt) }).runOnce(batchStartedAt);

    const [row] = await api.stack.sql<{ processed_at: Date }>(
      'select processed_at from wager_transactions where id = $1',
      [reversalId],
    );
    expect(row?.processed_at.getTime()).toBe(processedAt.getTime());
  });

  test('provedor desativado durante a espera: rejeita com PROVIDER_NOT_ALLOWED sem mexer no saldo', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet('REFUND', '25.00', 'provider-b');
    await submit(w, { providerId: 'provider-b', externalTransactionId: betExt });
    await onlyDue([reversalId]);
    await api.stack.sql(`update providers set active = false where id = 'provider-b'`);

    try {
      await reprocessAt(later(3_000));
      expect(await transaction(reversalId)).toMatchObject({
        status: 'REJECTED',
        failure_code: 'PROVIDER_NOT_ALLOWED',
      });
      const wallet = await api.request('GET', `/wallets/${w.walletId}`);
      expect(wallet.body.balance.amount).toBe('75.00');
    } finally {
      await api.stack.sql(`update providers set active = true where id = 'provider-b'`);
    }
  });

  test('referência existe mas nunca terminou: esgota como REFERENCE_NOT_PROCESSED', async () => {
    const w = await openWallet();
    const winExt = `win-${randomUUID()}`;
    await submit(w, {
      externalTransactionId: winExt,
      kind: 'WIN',
      referenceExternalTransactionId: `bet-que-nunca-chega-${randomUUID()}`,
    });
    const { res } = await submit(w, { kind: 'ROLLBACK', referenceExternalTransactionId: winExt });
    const rollbackId = res.body.transactionId as string;
    await onlyDue([rollbackId]);
    await api.stack.sql('update wager_transactions set reference_attempts = 10 where id = $1', [
      rollbackId,
    ]);

    await reprocessAt(later(3_000));

    expect((await transaction(rollbackId))?.failure_code).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('eventos gerados no reprocessamento mantêm a correlação da requisição original', async () => {
    const w = await openWallet();
    const betExt = `bet-${randomUUID()}`;
    const correlationId = `corr-${randomUUID()}`;
    const { res } = await submit(
      w,
      { kind: 'REFUND', referenceExternalTransactionId: betExt },
      { 'x-correlation-id': correlationId },
    );
    await submit(w, { externalTransactionId: betExt });
    await onlyDue([res.body.transactionId]);

    await reprocessAt(later(3_000));

    const [event] = await api.stack.sql<{ correlation: string }>(
      `select payload->>'correlationId' as correlation from outbox_messages
        where event_type = 'WagerTransactionProcessed'
          and payload->'data'->>'transactionId' = $1`,
      [res.body.transactionId],
    );
    expect(event?.correlation).toBe(correlationId);
  });

  test('a métrica só conta a pendência quando ela sai do estado pendente', async () => {
    const { w, betExt, reversalId } = await reversalBeforeBet();
    await onlyDue([reversalId]);
    const outcomes: WagerOutcome[] = [];
    const observer: WagerObserver = { transactionHandled: (o) => outcomes.push(o) };

    // Referência ainda ausente: só reagenda, nada de novo para contar.
    const parkedAt = later(3_000);
    await reprocessor({ clock: fixedClock(parkedAt), observer }).runOnce(parkedAt);
    expect(outcomes).toHaveLength(0);

    await submit(w, { externalTransactionId: betExt });
    const appliedAt = later(60_000);
    await reprocessor({ clock: fixedClock(appliedAt), observer }).runOnce(appliedAt);
    expect(outcomes.map((o) => String(o.result.status))).toEqual(['PROCESSED']);
  });
});
