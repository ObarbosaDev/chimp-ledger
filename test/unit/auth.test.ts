import { describe, expect, test } from 'bun:test';
import { Principal, ProviderMismatchError } from '../../src/auth/principal';
import { loadConfig } from '../../src/shared/infrastructure/config';

describe('Principal', () => {
  const providerA = new Principal('sub-1', 'provider-a', new Set(['wager:write']), 'provider-a');

  test('confere escopos exigidos', () => {
    expect(providerA.hasScopes(['wager:write'])).toBe(true);
    expect(providerA.hasScopes(['wager:write', 'wallet:reconcile'])).toBe(false);
    expect(providerA.hasScopes([])).toBe(true);
  });

  test('só age como o próprio provedor', () => {
    expect(() => providerA.assertActsAs('provider-a')).not.toThrow();
    expect(() => providerA.assertActsAs('provider-b')).toThrow(ProviderMismatchError);
  });

  test('client sem provider_id (backoffice) não age como provedor nenhum', () => {
    const backoffice = new Principal('sub-2', 'backoffice', new Set(['wallet:read']));
    expect(() => backoffice.assertActsAs('provider-a')).toThrow(ProviderMismatchError);
  });
});

describe('configuração de autenticação', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  test('autenticação ligada sem emissor não sobe', () => {
    expect(() => loadConfig({ ...base, AUTH_ENABLED: 'true' })).toThrow(/AUTH_ISSUER_URL/);
  });

  test('ligada com emissor, ou desligada, sobe', () => {
    expect(
      loadConfig({ ...base, AUTH_ENABLED: 'true', AUTH_ISSUER_URL: 'http://kc/realms/chimp' })
        .AUTH_ENABLED,
    ).toBe(true);
    expect(loadConfig(base).AUTH_ENABLED).toBe(false);
  });
});
