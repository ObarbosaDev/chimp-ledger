import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type ApiHarness, startApiHarness } from '../support/api-harness';
import { assertLedgerInvariant } from '../support/invariants';

// Concorrência de verdade: as requisições saem todas juntas (Promise.all) e
// cada uma pega a sua própria conexão no pool. Nada aqui é sequencial.
describe('concorrência na mesma carteira', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApiHarness();
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  async function openWallet(amount: string) {
    const playerId = randomUUID();
    const res = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    return { walletId: res.body.id as string, playerId };
  }

  function bet(w: { walletId: string; playerId: string }, amount: string, ext = randomUUID()) {
    const body = {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
    return api.request('POST', '/wagering/transactions', body, {
      'idempotency-key': `provider-a:${ext}`,
    });
  }

  const ledgerCount = async (walletId: string, direction: string) =>
    (
      await api.stack.sql<{ n: number }>(
        'select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = $2',
        [walletId, direction],
      )
    )[0]?.n;

  test('cenário obrigatório: duas apostas de 80 sobre 100 ao mesmo tempo', async () => {
    const w = await openWallet('100.00');

    const results = await Promise.all([bet(w, '80.00'), bet(w, '80.00')]);
    const statuses = results.map((r) => r.body.status).sort();

    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.body.status === 'REJECTED')?.body.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
    const wallet = await api.request('GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance.amount).toBe('20.00');
    expect(await ledgerCount(w.walletId, 'DEBIT')).toBe(1);
    await assertLedgerInvariant(api.stack, w.walletId);
  });

  test('a mesma aposta enviada 50 vezes em paralelo debita uma vez só', async () => {
    const w = await openWallet('100.00');
    const ext = randomUUID();

    const results = await Promise.all(Array.from({ length: 50 }, () => bet(w, '10.00', ext)));

    const transactionIds = new Set(results.map((r) => r.body.transactionId));
    expect(transactionIds.size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === '90.00')).toBe(true);
    expect(await ledgerCount(w.walletId, 'DEBIT')).toBe(1);
    await assertLedgerInvariant(api.stack, w.walletId);
  });

  test('várias apostas concorrentes nunca deixam o saldo negativo', async () => {
    const w = await openWallet('100.00');

    // 30 apostas de 7.00 = 210.00 disputando 100.00: no máximo 14 passam.
    const results = await Promise.all(Array.from({ length: 30 }, () => bet(w, '7.00')));
    const processed = results.filter((r) => r.body.status === 'PROCESSED').length;

    expect(processed).toBe(14);
    const wallet = await api.request('GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance.amount).toBe('2.00');
    expect(wallet.body.version).toBe(15);
    await assertLedgerInvariant(api.stack, w.walletId);
  });

  test('carteiras diferentes processam em paralelo sem interferir uma na outra', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('50.00')));

    await Promise.all(wallets.flatMap((w) => Array.from({ length: 5 }, () => bet(w, '10.00'))));

    for (const w of wallets) {
      const wallet = await api.request('GET', `/wallets/${w.walletId}`);
      expect(wallet.body.balance.amount).toBe('0.00');
      await assertLedgerInvariant(api.stack, w.walletId);
    }
  });
});
