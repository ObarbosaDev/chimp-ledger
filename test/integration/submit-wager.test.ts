import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type ApiHarness, startApiHarness } from '../support/api-harness';
import { assertLedgerInvariant } from '../support/invariants';

describe('POST /wagering/transactions', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApiHarness();
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  async function openWallet(amount = '1000.00', currency = 'BRL') {
    const playerId = randomUUID();
    const res = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency },
    });
    return { walletId: res.body.id as string, playerId };
  }

  function wager(
    w: { walletId: string; playerId: string },
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
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
  }

  const submit = (body: Record<string, unknown>, key?: string) =>
    api.request('POST', '/wagering/transactions', body, {
      'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}`,
    });

  const countLedger = async (walletId: string) =>
    (
      await api.stack.sql<{ n: number }>(
        'select count(*)::int as n from wallet_ledger_entries where wallet_id = $1',
        [walletId],
      )
    )[0]?.n;

  const outboxTypes = async (walletId: string) =>
    (
      await api.stack.sql<{ event_type: string }>(
        'select event_type from outbox_messages where aggregate_id = $1 order by occurred_at, event_type',
        [walletId],
      )
    ).map((r) => r.event_type);

  describe('BET', () => {
    test('debita, grava lançamento e enfileira os eventos', async () => {
      const w = await openWallet();
      const res = await submit(wager(w));

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await countLedger(w.walletId)).toBe(2);
      expect(await outboxTypes(w.walletId)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      await assertLedgerInvariant(api.stack, w.walletId);
    });

    test('replay idêntico devolve a mesma resposta e não debita de novo', async () => {
      const w = await openWallet();
      const body = wager(w);
      const first = await submit(body);
      await submit(wager(w)); // outra aposta no meio muda o saldo atual
      const replay = await submit(body);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      // saldo daquele momento, não o atual
      expect(replay.body.balance.amount).toBe('975.00');
      expect(await countLedger(w.walletId)).toBe(3);
    });

    test('mesma chave com payload diferente é conflito, não replay', async () => {
      const w = await openWallet();
      const body = wager(w);
      await submit(body);
      const res = await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
      expect(await countLedger(w.walletId)).toBe(2);
    });

    test('mesmo externalTransactionId com outra chave é conflito', async () => {
      const w = await openWallet();
      const body = wager(w);
      await submit(body);
      const res = await submit(body, 'provider-a:outra-chave');
      expect(res.status).toBe(409);
    });

    test('saldo insuficiente → 422 INSUFFICIENT_FUNDS, sem lançamento, auditável', async () => {
      const w = await openWallet('10.00');
      const res = await submit(wager(w, { money: { amount: '10.01', currency: 'BRL' } }));

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await countLedger(w.walletId)).toBe(1);
      expect(await outboxTypes(w.walletId)).toEqual(['WagerTransactionRejected']);

      const stored = await api.request('GET', `/wagering/transactions/${res.body.transactionId}`);
      expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    });

    test('replay de uma rejeição devolve a mesma rejeição', async () => {
      const w = await openWallet('1.00');
      const body = wager(w);
      await submit(body);
      const replay = await submit(body);
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: true,
      });
    });
  });

  describe('WIN e LOSS', () => {
    test('WIN credita e pode referenciar a BET da rodada', async () => {
      const w = await openWallet('100.00');
      const bet = wager(w);
      await submit(bet);
      const res = await submit(
        wager(w, {
          kind: 'WIN',
          money: { amount: '60.00', currency: 'BRL' },
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.balance.amount).toBe('135.00');
      await assertLedgerInvariant(api.stack, w.walletId);
    });

    test('LOSS registra sem mexer no saldo e sem lançamento', async () => {
      const w = await openWallet('100.00');
      const res = await submit(
        wager(w, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
      expect(await countLedger(w.walletId)).toBe(1);
      expect(await outboxTypes(w.walletId)).toEqual(['WagerTransactionProcessed']);
    });
  });

  describe('REFUND e ROLLBACK', () => {
    test('REFUND devolve a BET uma única vez', async () => {
      const w = await openWallet('100.00');
      const bet = wager(w, { money: { amount: '40.00', currency: 'BRL' } });
      await submit(bet);
      const refund = (ext: string) =>
        submit(
          wager(w, {
            externalTransactionId: ext,
            kind: 'REFUND',
            money: { amount: '40.00', currency: 'BRL' },
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );

      const first = await refund('refund-1');
      expect(first.status).toBe(201);
      expect(first.body.balance.amount).toBe('100.00');

      const second = await refund('refund-2');
      expect(second.status).toBe(422);
      expect(second.body.failureCode).toBe('ALREADY_REVERSED');
      await assertLedgerInvariant(api.stack, w.walletId);
    });

    test('ROLLBACK de BET depois de REFUND também é recusado (reversão única)', async () => {
      const w = await openWallet('100.00');
      const bet = wager(w, { money: { amount: '40.00', currency: 'BRL' } });
      await submit(bet);
      const reversal = (kind: string) =>
        submit(
          wager(w, {
            kind,
            money: { amount: '40.00', currency: 'BRL' },
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );
      expect((await reversal('REFUND')).status).toBe(201);
      const rollback = await reversal('ROLLBACK');
      expect(rollback.body.failureCode).toBe('ALREADY_REVERSED');
    });

    test('ROLLBACK de WIN debita o prêmio', async () => {
      const w = await openWallet('100.00');
      const win = wager(w, { kind: 'WIN', money: { amount: '30.00', currency: 'BRL' } });
      await submit(win);
      const res = await submit(
        wager(w, {
          kind: 'ROLLBACK',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.balance.amount).toBe('100.00');
    });

    test('ROLLBACK de WIN já gasto → NEGATIVE_BALANCE_PREVENTED (diferente de sem saldo)', async () => {
      const w = await openWallet('0.00');
      const win = wager(w, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
      await submit(win);
      await submit(wager(w, { money: { amount: '50.00', currency: 'BRL' } }));
      const res = await submit(
        wager(w, {
          kind: 'ROLLBACK',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('NEGATIVE_BALANCE_PREVENTED');
      expect(res.body.balance.amount).toBe('0.00');
    });

    test('REFUND com valor diferente da BET → AMOUNT_MISMATCH', async () => {
      const w = await openWallet('100.00');
      const bet = wager(w);
      await submit(bet);
      const res = await submit(
        wager(w, {
          kind: 'REFUND',
          money: { amount: '24.99', currency: 'BRL' },
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(res.body.failureCode).toBe('AMOUNT_MISMATCH');
    });

    test('REFUND de outra rodada → REFERENCE_MISMATCH', async () => {
      const w = await openWallet('100.00');
      const bet = wager(w);
      await submit(bet);
      const res = await submit(
        wager(w, {
          kind: 'REFUND',
          roundId: 'round-2',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(res.body.failureCode).toBe('REFERENCE_MISMATCH');
    });

    test('REFUND antes da BET → 202 PENDING_REFERENCE, sem mexer em saldo', async () => {
      const w = await openWallet('100.00');
      const res = await submit(
        wager(w, { kind: 'REFUND', referenceExternalTransactionId: 'bet-que-ainda-nao-chegou' }),
      );
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        status: 'PENDING_REFERENCE',
        balance: { amount: '100.00' },
      });
      expect(await outboxTypes(w.walletId)).toEqual(['WagerTransactionPendingReference']);
    });
  });

  // Uma aposta é liquidada uma vez (WIN ou LOSS) e, depois de liquidada, não
  // pode ser reembolsada; depois de revertida, não pode ser liquidada. É o
  // que impede o jogador de ficar com o prêmio e com a aposta de volta.
  describe('liquidação da aposta', () => {
    async function settledRound(settlement: 'WIN' | 'LOSS') {
      const w = await openWallet('100.00');
      const bet = wager(w, { money: { amount: '40.00', currency: 'BRL' } });
      await submit(bet);
      const settle = wager(w, {
        kind: settlement,
        money: { amount: settlement === 'WIN' ? '90.00' : '0.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect((await submit(settle)).status).toBe(201);
      return { w, bet, settle };
    }

    const reverse = (
      w: { walletId: string; playerId: string },
      kind: string,
      target: Record<string, unknown>,
    ) =>
      submit(
        wager(w, {
          kind,
          money: target.money,
          referenceExternalTransactionId: target.externalTransactionId,
        }),
      );

    test('BET já paga com WIN não aceita REFUND', async () => {
      const { w, bet } = await settledRound('WIN');
      const res = await reverse(w, 'REFUND', bet);
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('BET_ALREADY_SETTLED');
      await assertLedgerInvariant(api.stack, w.walletId);
    });

    test('BET encerrada com LOSS não aceita ROLLBACK', async () => {
      const { w, bet } = await settledRound('LOSS');
      expect((await reverse(w, 'ROLLBACK', bet)).body.failureCode).toBe('BET_ALREADY_SETTLED');
    });

    test('BET já liquidada não aceita um segundo WIN', async () => {
      const { w, bet } = await settledRound('WIN');
      const res = await submit(
        wager(w, {
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(res.body.failureCode).toBe('BET_ALREADY_SETTLED');
    });

    test('BET reembolsada não aceita WIN', async () => {
      const w = await openWallet('100.00');
      const bet = wager(w, { money: { amount: '40.00', currency: 'BRL' } });
      await submit(bet);
      expect((await reverse(w, 'REFUND', bet)).status).toBe(201);
      const res = await submit(
        wager(w, {
          kind: 'WIN',
          money: { amount: '90.00', currency: 'BRL' },
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      expect(res.body.failureCode).toBe('ALREADY_REVERSED');
    });

    test('depois do ROLLBACK do WIN, a BET volta a aceitar REFUND', async () => {
      const { w, bet, settle } = await settledRound('WIN');
      expect((await reverse(w, 'ROLLBACK', settle)).status).toBe(201);
      const res = await reverse(w, 'REFUND', bet);
      expect(res.status).toBe(201);
      expect(res.body.balance.amount).toBe('100.00');
      await assertLedgerInvariant(api.stack, w.walletId);
    });
  });

  describe('validação e contexto', () => {
    test('sem Idempotency-Key → 400', async () => {
      const w = await openWallet();
      const res = await api.request('POST', '/wagering/transactions', wager(w));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PAYLOAD');
    });

    test.each([
      ['OPENING', { kind: 'OPENING' }],
      ['kind desconhecido', { kind: 'JACKPOT' }],
      ['valor zero em BET', { money: { amount: '0.00', currency: 'BRL' } }],
      ['valor como number', { money: { amount: 25, currency: 'BRL' } }],
      ['REFUND sem referência', { kind: 'REFUND' }],
      ['campo extra', { bonus: true }],
    ])('payload inválido (%s) → 400', async (_n, over) => {
      const w = await openWallet();
      const res = await submit(wager(w, over));
      expect(res.status).toBe(400);
    });

    test('moeda diferente da carteira → 422 CURRENCY_MISMATCH', async () => {
      const w = await openWallet('100.00', 'BRL');
      const res = await submit(wager(w, { money: { amount: '1.00', currency: 'USD' } }));
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    });

    test('carteira de outro jogador → 422 WALLET_PLAYER_MISMATCH sem revelar o saldo dela', async () => {
      const w = await openWallet('100.00');
      const body = wager({ ...w, playerId: randomUUID() });
      const res = await submit(body);
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
      expect(res.body.balance).toBeUndefined();

      const replay = await submit(body);
      expect(replay.body.balance).toBeUndefined();

      const stored = await api.request('GET', `/wagering/transactions/${res.body.transactionId}`);
      expect(stored.body.balance).toBeUndefined();

      const [event] = await api.stack.sql<{ data: Record<string, unknown> }>(
        `select payload->'data' as data from outbox_messages
          where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = $1`,
        [res.body.transactionId],
      );
      // ausente ou null: o que importa é não ter valor nenhum
      expect(event?.data.resultBalance ?? null).toBeNull();
    });

    test('carteira inexistente → 404 WALLET_NOT_FOUND', async () => {
      const res = await submit(wager({ walletId: randomUUID(), playerId: randomUUID() }));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('WALLET_NOT_FOUND');
    });

    test('provedor desconhecido → 422 PROVIDER_NOT_ALLOWED', async () => {
      const w = await openWallet();
      const res = await submit(wager(w, { providerId: 'provider-zzz' }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PROVIDER_NOT_ALLOWED');
    });
  });

  describe('consultas', () => {
    test('busca por id interno e por (provedor, id externo) devolvem a mesma transação', async () => {
      const w = await openWallet();
      const body = wager(w);
      const created = await submit(body);
      const byId = await api.request('GET', `/wagering/transactions/${created.body.transactionId}`);
      const byExternal = await api.request(
        'GET',
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      );
      expect(byId.status).toBe(200);
      expect(byExternal.body).toEqual(byId.body);
      expect(byId.body).toMatchObject({
        transactionId: created.body.transactionId,
        externalTransactionId: body.externalTransactionId,
        kind: 'BET',
        status: 'PROCESSED',
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '975.00', currency: 'BRL' },
      });
    });

    test('transação inexistente → 404', async () => {
      expect((await api.request('GET', `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    });
  });
});
