import { describe, expect, test } from 'bun:test';
import { FAILURE_CODE_META, FailureCode } from '../../../src/wagering/domain/failure-code';
import { computePayloadHash } from '../../../src/wagering/domain/payload-hash';
import { ReferenceRetryPolicy } from '../../../src/wagering/domain/reference-retry-policy';

const fields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p',
  walletId: 'w',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('computePayloadHash', () => {
  test('é estável e independe da ordem das chaves', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'w',
      playerId: 'p',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(fields)).toBe(computePayloadHash(reordered));
    expect(computePayloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('muda quando qualquer campo de negócio muda', () => {
    const base = computePayloadHash(fields);
    expect(computePayloadHash({ ...fields, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      base,
    );
    expect(computePayloadHash({ ...fields, roundId: 'round-988' })).not.toBe(base);
    expect(computePayloadHash({ ...fields, referenceExternalTransactionId: 'x' })).not.toBe(base);
  });
});

describe('FAILURE_CODE_META', () => {
  test('todo código tem ação definida para o provedor', () => {
    for (const code of Object.values(FailureCode)) {
      expect(['RETRY', 'FIX_PAYLOAD', 'GIVE_UP']).toContain(FAILURE_CODE_META[code].action);
    }
  });

  test('sem saldo e reversão que negativaria são códigos diferentes', () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.NegativeBalancePrevented);
  });
});

describe('ReferenceRetryPolicy', () => {
  const policy = new ReferenceRetryPolicy({
    baseDelayMs: 2_000,
    maxDelayMs: 300_000,
    maxAttempts: 10,
    ttlMs: 3_600_000,
  });
  const t0 = new Date('2026-11-20T12:00:00.000Z');

  test('backoff exponencial a partir de 2s com teto de 5min', () => {
    expect(policy.delayFor(1)).toBe(2_000);
    expect(policy.delayFor(2)).toBe(4_000);
    expect(policy.delayFor(5)).toBe(32_000);
    expect(policy.delayFor(9)).toBe(300_000);
  });

  test('esgota por número de tentativas', () => {
    expect(policy.isExhausted({ attempts: 9, createdAt: t0, now: t0 })).toBe(false);
    expect(policy.isExhausted({ attempts: 10, createdAt: t0, now: t0 })).toBe(true);
  });

  test('esgota por TTL mesmo com poucas tentativas', () => {
    const later = new Date(t0.getTime() + 3_600_000);
    expect(policy.isExhausted({ attempts: 1, createdAt: t0, now: later })).toBe(true);
  });
});
