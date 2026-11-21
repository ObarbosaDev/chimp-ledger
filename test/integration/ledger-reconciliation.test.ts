import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type ApiHarness, startApiHarness } from '../support/api-harness';

describe('ledger paginado e reconciliação', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApiHarness();
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  /** Carteira com 1 lançamento de abertura + `bets` apostas de 1.00. */
  async function walletWithEntries(bets: number) {
    const playerId = randomUUID();
    const res = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = res.body.id as string;
    for (let i = 0; i < bets; i++) await bet(walletId, playerId);
    return { walletId, playerId };
  }

  function bet(walletId: string, playerId: string) {
    const ext = `bet-${randomUUID()}`;
    return api.request(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: ext,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      { 'idempotency-key': `provider-a:${ext}` },
    );
  }

  const page = (walletId: string, query = '') =>
    api.request('GET', `/wallets/${walletId}/ledger${query}`);

  async function readAll(walletId: string, limit: number): Promise<number[]> {
    const sequences: number[] = [];
    let cursor: string | null = null;
    do {
      const query = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await page(walletId, query);
      expect(res.status).toBe(200);
      sequences.push(...res.body.items.map((e: { sequence: number }) => e.sequence));
      cursor = res.body.nextCursor;
    } while (cursor);
    return sequences;
  }

  describe('GET /wallets/:id/ledger', () => {
    test('devolve os lançamentos em ordem, com os campos de auditoria', async () => {
      const { walletId } = await walletWithEntries(1);
      const res = await page(walletId);

      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[1]).toEqual({
        id: expect.any(String),
        transactionId: expect.any(String),
        sequence: 2,
        direction: 'DEBIT',
        money: { amount: '1.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '99.00', currency: 'BRL' },
        prevHash: res.body.items[0].entryHash,
        entryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        createdAt: expect.any(String),
      });
    });

    test('percorre todas as páginas sem repetir nem pular', async () => {
      const { walletId } = await walletWithEntries(10);
      expect(await readAll(walletId, 4)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    });

    test('lançamento novo no meio da leitura não bagunça o que já foi lido', async () => {
      const { walletId, playerId } = await walletWithEntries(4);
      const first = await page(walletId, '?limit=3');
      await bet(walletId, playerId);
      await bet(walletId, playerId);

      const rest = await readAll(walletId, 3).then((all) => all.slice(3));
      const seen = [...first.body.items.map((e: { sequence: number }) => e.sequence), ...rest];
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    test.each([
      ['cursor adulterado', '?cursor=isso-nao-e-um-cursor'],
      [
        'cursor com conteúdo inválido',
        `?cursor=${Buffer.from('{"after":-3}').toString('base64url')}`,
      ],
      ['limit zero', '?limit=0'],
      ['limit acima do máximo', '?limit=500'],
      [
        'cursor apontando além do maior número possível',
        `?cursor=${Buffer.from('{"v":1,"after":3000000000}').toString('base64url')}`,
      ],
    ])('%s → 400', async (_n, query) => {
      const { walletId } = await walletWithEntries(0);
      const res = await page(walletId, query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PAYLOAD');
    });

    test('carteira inexistente → 404', async () => {
      expect((await page(randomUUID())).status).toBe(404);
    });
  });

  describe('POST /wallets/:id/reconciliation', () => {
    const reconcile = (walletId: string) =>
      api.request('POST', `/wallets/${walletId}/reconciliation`);

    test('carteira íntegra: consistente, corrente válida e contagem certa', async () => {
      const { walletId } = await walletWithEntries(3);
      const res = await reconcile(walletId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId,
        storedBalance: { amount: '97.00', currency: 'BRL' },
        calculatedBalance: { amount: '97.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 4,
        chainValid: true,
        firstBrokenSequence: null,
      });
    });

    test('saldo mexido direto no banco: aponta a diferença e não corrige', async () => {
      const { walletId } = await walletWithEntries(2);
      await api.stack.sql(`
        alter table wallets disable trigger user;
        update wallets set balance = balance + 5 where id = '${walletId}';
        alter table wallets enable trigger user;
      `);

      const res = await reconcile(walletId);

      expect(res.body).toMatchObject({
        storedBalance: { amount: '103.00' },
        calculatedBalance: { amount: '98.00' },
        difference: { amount: '5.00' },
        consistent: false,
        chainValid: true,
      });
      const wallet = await api.request('GET', `/wallets/${walletId}`);
      expect(wallet.body.balance.amount).toBe('103.00');
    });

    test('linha do ledger adulterada: corrente quebrada a partir dela', async () => {
      const { walletId } = await walletWithEntries(3);
      await api.stack.sql(`
        alter table wallet_ledger_entries disable trigger user;
        update wallet_ledger_entries set amount = 2, balance_after = balance_before - 2
         where wallet_id = '${walletId}' and sequence = 3;
        alter table wallet_ledger_entries enable trigger user;
      `);

      const res = await reconcile(walletId);

      expect(res.body).toMatchObject({
        consistent: false,
        chainValid: false,
        firstBrokenSequence: 3,
      });
    });

    test('carteira inexistente → 404', async () => {
      expect((await reconcile(randomUUID())).status).toBe(404);
    });
  });
});
