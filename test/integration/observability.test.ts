import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createApiApp } from '../../src/bootstrap/api';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { type ApiHarness, startApiHarness } from '../support/api-harness';

describe('observabilidade da API', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApiHarness({ captureLogs: true });
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  async function walletAndBet(amount = '25.00') {
    const playerId = randomUUID();
    const wallet = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const ext = `tx-${randomUUID()}`;
    const body = {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId,
      walletId: wallet.body.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
    const send = (correlationId?: string) =>
      api.request('POST', '/wagering/transactions', body, {
        'idempotency-key': `provider-a:${ext}`,
        ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      });
    return { walletId: wallet.body.id as string, send };
  }

  const metrics = async () => (await api.app.inject({ method: 'GET', url: '/metrics' })).body;

  const sample = (text: string, name: string, labels: Record<string, string> = {}) => {
    const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    const line = text
      .split('\n')
      .find(
        (l) =>
          (l.startsWith(`${name}{`) || l.startsWith(`${name} `)) &&
          wanted.every((w) => l.includes(w)),
      );
    return line ? Number(line.split(' ').at(-1)) : 0;
  };

  describe('health checks', () => {
    test('/health/live responde sem depender de nada', async () => {
      const res = await api.request('GET', '/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    test('/health/ready confere Postgres e SQS de verdade', async () => {
      const res = await api.request('GET', '/health/ready');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
    });

    test('/health/ready responde 503 quando o SQS não está alcançável', async () => {
      const app = await createApiApp(
        loadConfig({
          DATABASE_URL: api.stack.appUrl,
          SQS_ENDPOINT: 'http://127.0.0.1:1',
          LOG_LEVEL: 'silent',
        }),
      );
      try {
        const res = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({
          status: 'unavailable',
          checks: { postgres: 'up', sqs: 'down' },
        });
      } finally {
        await app.close();
      }
    });
  });

  describe('métricas', () => {
    test('contam transações por status e duplicatas, e medem a latência', async () => {
      const before = await metrics();
      const { send } = await walletAndBet();
      await send();
      await send(); // replay
      const rejected = await walletAndBet('500.00');
      await rejected.send();
      const after = await metrics();

      const processed = { status: 'PROCESSED', kind: 'BET', source: 'http' };
      expect(sample(after, 'wager_transactions_total', processed)).toBe(
        sample(before, 'wager_transactions_total', processed) + 1,
      );
      const rejections = { status: 'REJECTED', kind: 'BET', source: 'http' };
      expect(sample(after, 'wager_transactions_total', rejections)).toBe(
        sample(before, 'wager_transactions_total', rejections) + 1,
      );
      expect(sample(after, 'wager_duplicates_total', { source: 'http' })).toBe(
        sample(before, 'wager_duplicates_total', { source: 'http' }) + 1,
      );
      expect(after).toContain('wager_processing_seconds_bucket');
    });

    test('divergência de reconciliação vira métrica', async () => {
      const { walletId } = await walletAndBet();
      await api.stack.sql(`
        alter table wallets disable trigger user;
        update wallets set balance = balance + 1 where id = '${walletId}';
        alter table wallets enable trigger user;
      `);
      const before = sample(await metrics(), 'reconciliation_divergences_total');
      await api.request('POST', `/wallets/${walletId}/reconciliation`);
      expect(sample(await metrics(), 'reconciliation_divergences_total')).toBe(before + 1);
    });
  });

  describe('logs', () => {
    test('a transação gera uma linha JSON com os ids de rastreio e sem valores', async () => {
      const correlationId = `corr-${randomUUID()}`;
      const { walletId, send } = await walletAndBet('37.42');
      const res = await send(correlationId);

      const line = api.logs
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.event === 'wager.transaction' && l.correlationId === correlationId);

      expect(line).toMatchObject({
        level: 'info',
        correlationId,
        transactionId: res.body.transactionId,
        walletId,
        providerId: 'provider-a',
        status: 'PROCESSED',
      });
      const raw = api.logs.join('\n');
      expect(raw).not.toContain('37.42');
    });
  });
});
