import { describe, expect, test } from 'bun:test';
import { percentile, summarize } from './stats';

describe('estatísticas do teste de carga', () => {
  test('percentil pelo método do posto mais próximo', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
  });

  test('não depende da ordem de entrada', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
  });

  test('lista vazia não inventa número', () => {
    expect(percentile([], 99)).toBeNaN();
    expect(summarize([]).count).toBe(0);
  });

  test('resumo traz contagem, média e os percentis', () => {
    expect(summarize([4, 1, 3, 2])).toEqual({
      count: 4,
      mean: 2.5,
      p50: 2,
      p95: 4,
      p99: 4,
      max: 4,
    });
  });
});
