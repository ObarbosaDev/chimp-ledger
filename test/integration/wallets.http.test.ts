import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type ApiHarness, startApiHarness } from '../support/api-harness';
import { assertLedgerInvariantForAllWallets } from '../support/invariants';

describe('HTTP /wallets', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApiHarness();
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  test('abre carteira com saldo inicial, OPENING e lançamento na mesma transação', async () => {
    const playerId = randomUUID();
    const res = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const walletId = res.body.id;
    const [opening] = await api.stack.sql<{ kind: string; status: string; amount: string }>(
      'select kind, status, amount from wager_transactions where wallet_id = $1',
      [walletId],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });

    const entries = await api.stack.sql<{ direction: string; sequence: number }>(
      'select direction, sequence from wallet_ledger_entries where wallet_id = $1',
      [walletId],
    );
    expect(entries).toEqual([{ direction: 'CREDIT', sequence: 1 }]);
  });

  test('saldo inicial zero abre a carteira sem OPENING e sem lançamento', async () => {
    const res = await api.request('POST', '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(res.status).toBe(201);
    const [{ n }] = (await api.stack.sql<{ n: number }>(
      'select count(*)::int as n from wallet_ledger_entries where wallet_id = $1',
      [res.body.id],
    )) as [{ n: number }];
    expect(n).toBe(0);
  });

  test('segunda carteira do mesmo jogador na mesma moeda é conflito (409)', async () => {
    const body = { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } };
    expect((await api.request('POST', '/wallets', body)).status).toBe(201);

    const dup = await api.request('POST', '/wallets', body);
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
  });

  test('mesmo jogador pode ter carteira em outra moeda', async () => {
    const playerId = randomUUID();
    await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const usd = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '10.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
  });

  test.each([
    [
      'amount numérico',
      { playerId: randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } },
    ],
    [
      'amount com 3 casas',
      { playerId: randomUUID(), initialBalance: { amount: '1.005', currency: 'BRL' } },
    ],
    [
      'amount negativo',
      { playerId: randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } },
    ],
    [
      'playerId que não é uuid',
      { playerId: 'abc', initialBalance: { amount: '1.00', currency: 'BRL' } },
    ],
    [
      'campo desconhecido',
      { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' }, admin: true },
    ],
    ['corpo vazio', {}],
  ])('payload inválido (%s) → 400 INVALID_PAYLOAD', async (_caso, body) => {
    const res = await api.request('POST', '/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD', retryable: false });
  });

  test('GET /wallets/:id devolve o estado atual', async () => {
    const created = await api.request('POST', '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '55.10', currency: 'BRL' },
    });
    const res = await api.request('GET', `/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  test('GET de carteira inexistente → 404 WALLET_NOT_FOUND', async () => {
    const res = await api.request('GET', `/wallets/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  test('GET com id que não é uuid → 400', async () => {
    expect((await api.request('GET', '/wallets/nao-e-uuid')).status).toBe(400);
  });

  test('invariante final: em toda carteira, saldo igual ao reconstruído pelo ledger', async () => {
    expect(await assertLedgerInvariantForAllWallets(api.stack)).toBeGreaterThan(0);
  });
});
