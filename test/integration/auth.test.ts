import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type ApiHarness, startApiHarness } from '../support/api-harness';
import { startKeycloak, type TestKeycloak } from '../support/keycloak';

describe('autenticação com Keycloak', () => {
  let keycloak: TestKeycloak;
  let api: ApiHarness;
  let tokens: { providerA: string; providerB: string; backoffice: string };

  beforeAll(async () => {
    keycloak = await startKeycloak();
    api = await startApiHarness({
      env: {
        AUTH_ENABLED: 'true',
        AUTH_ISSUER_URL: keycloak.issuer,
        AUTH_AUDIENCE: 'chimp-ledger',
      },
    });
    tokens = {
      providerA: await keycloak.token('provider-a', 'provider-a-dev-secret'),
      providerB: await keycloak.token('provider-b', 'provider-b-dev-secret'),
      backoffice: await keycloak.token('backoffice', 'backoffice-dev-secret'),
    };
  }, 300_000);

  afterAll(async () => {
    await api?.stop();
    await keycloak?.stop();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function openWallet() {
    const playerId = randomUUID();
    const res = await api.request(
      'POST',
      '/wallets',
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      bearer(tokens.backoffice),
    );
    expect(res.status).toBe(201);
    return { walletId: res.body.id as string, playerId };
  }

  function bet(
    w: { walletId: string; playerId: string },
    token: string,
    providerId = 'provider-a',
  ) {
    const ext = `tx-${randomUUID()}`;
    return api.request(
      'POST',
      '/wagering/transactions',
      {
        providerId,
        externalTransactionId: ext,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      { 'idempotency-key': `${providerId}:${ext}`, ...bearer(token) },
    );
  }

  test('sem token → 401', async () => {
    const res = await api.request('GET', `/wallets/${randomUUID()}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
  });

  test('token forjado (assinatura inválida) → 401', async () => {
    const [header, payload] = tokens.providerA.split('.');
    const forged = `${header}.${payload}.${Buffer.from('assinatura-falsa').toString('base64url')}`;
    const res = await api.request('GET', `/wallets/${randomUUID()}`, undefined, bearer(forged));
    expect(res.status).toBe(401);
  });

  test('provedor envia aposta em nome dele → 201', async () => {
    const w = await openWallet();
    const res = await bet(w, tokens.providerA);
    expect(res.status).toBe(201);
  });

  test('provedor A tentando enviar como provedor B → 403', async () => {
    const w = await openWallet();
    const res = await bet(w, tokens.providerA, 'provider-b');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PROVIDER_MISMATCH' });
  });

  test('provedor não abre carteira nem roda reconciliação (falta escopo) → 403', async () => {
    const open = await api.request(
      'POST',
      '/wallets',
      { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } },
      bearer(tokens.providerB),
    );
    expect(open.status).toBe(403);
    expect(open.body).toMatchObject({ code: 'FORBIDDEN' });

    const w = await openWallet();
    const reconcile = await api.request(
      'POST',
      `/wallets/${w.walletId}/reconciliation`,
      undefined,
      bearer(tokens.providerB),
    );
    expect(reconcile.status).toBe(403);
  });

  // A carteira é do jogador e é compartilhada por todos os provedores em que
  // ele joga. O ledger mostra tudo, de todos; por isso é só do backoffice.
  test('provedor não lê o ledger completo da carteira (atividade de outros provedores)', async () => {
    const w = await openWallet();
    await bet(w, tokens.providerA);

    const asProvider = await api.request(
      'GET',
      `/wallets/${w.walletId}/ledger`,
      undefined,
      bearer(tokens.providerB),
    );
    expect(asProvider.status).toBe(403);
    expect(asProvider.headers['www-authenticate']).toContain('scope="ledger:read"');

    const asBackoffice = await api.request(
      'GET',
      `/wallets/${w.walletId}/ledger`,
      undefined,
      bearer(tokens.backoffice),
    );
    expect(asBackoffice.status).toBe(200);
    expect(asBackoffice.body.items).toHaveLength(2);
  });

  test('backoffice lê transação de qualquer provedor pelo escopo explícito', async () => {
    const w = await openWallet();
    const created = await bet(w, tokens.providerA);
    const byId = await api.request(
      'GET',
      `/wagering/transactions/${created.body.transactionId}`,
      undefined,
      bearer(tokens.backoffice),
    );
    expect(byId.status).toBe(200);
    expect(byId.body.providerId).toBe('provider-a');
  });

  test('backoffice roda a reconciliação', async () => {
    const w = await openWallet();
    const res = await api.request(
      'POST',
      `/wallets/${w.walletId}/reconciliation`,
      undefined,
      bearer(tokens.backoffice),
    );
    expect(res.status).toBe(200);
    expect(res.body.consistent).toBe(true);
  });

  test('provedor só consulta transação externa dele mesmo', async () => {
    const res = await api.request(
      'GET',
      '/providers/provider-b/wagering/transactions/qualquer',
      undefined,
      bearer(tokens.providerA),
    );
    expect(res.status).toBe(403);
  });

  test('health checks e métricas continuam abertos', async () => {
    expect((await api.request('GET', '/health/live')).status).toBe(200);
    expect((await api.request('GET', '/health/ready')).status).toBe(200);
    expect((await api.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  test('401 e 403 dizem ao cliente o que fazer no header (RFC 6750)', async () => {
    const missing = await api.request('GET', `/wallets/${randomUUID()}`);
    expect(missing.headers['www-authenticate']).toBe('Bearer realm="chimp-ledger"');

    const invalid = await api.request(
      'GET',
      `/wallets/${randomUUID()}`,
      undefined,
      bearer('a.b.c'),
    );
    expect(invalid.headers['www-authenticate']).toBe(
      'Bearer realm="chimp-ledger", error="invalid_token"',
    );

    const w = await openWallet();
    const forbidden = await api.request(
      'POST',
      `/wallets/${w.walletId}/reconciliation`,
      undefined,
      bearer(tokens.providerA),
    );
    expect(forbidden.headers['www-authenticate']).toBe(
      'Bearer realm="chimp-ledger", error="insufficient_scope", scope="wallet:reconcile"',
    );
  });

  test('token válido do mesmo Keycloak, mas emitido para outra aplicação → 401', async () => {
    const other = await keycloak.token('integracao-sem-audiencia', 'integracao-dev-secret');
    const res = await api.request('GET', `/wallets/${randomUUID()}`, undefined, bearer(other));
    expect(res.status).toBe(401);
  });

  test('transação de outro provedor, pelo id interno, responde como inexistente', async () => {
    const w = await openWallet();
    const created = await bet(w, tokens.providerA);
    const res = await api.request(
      'GET',
      `/wagering/transactions/${created.body.transactionId}`,
      undefined,
      bearer(tokens.providerB),
    );
    expect(res.status).toBe(404);
  });

  test('recusas de autenticação entram na métrica por motivo', async () => {
    await api.request('GET', `/wallets/${randomUUID()}`);
    const metrics = (await api.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/^auth_failures_total\{reason="missing_token"\} [1-9]/m);
    expect(metrics).toMatch(/^auth_failures_total\{reason="insufficient_scope"\} [1-9]/m);
  });

  test('Keycloak fora do ar: 503 (tente de novo), e não 401 (credencial errada)', async () => {
    const offline = await startApiHarness({
      env: {
        AUTH_ENABLED: 'true',
        AUTH_ISSUER_URL: 'http://127.0.0.1:1/realms/chimp',
        AUTH_AUDIENCE: 'chimp-ledger',
      },
    });
    try {
      const res = await offline.request(
        'GET',
        `/wallets/${randomUUID()}`,
        undefined,
        bearer(tokens.providerA),
      );
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });
    } finally {
      await offline.stop();
    }
  }, 180_000);
});
