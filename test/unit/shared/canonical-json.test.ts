import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256Hex } from '../../../src/shared/domain/canonical-json';

describe('canonicalJson', () => {
  test('ordena chaves em todos os níveis, então a ordem de chegada não importa', () => {
    const a = canonicalJson({ b: 1, a: { d: 'x', c: 'y' } });
    const b = canonicalJson({ a: { c: 'y', d: 'x' }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"y","d":"x"},"b":1}');
  });

  test('mantém a ordem dos arrays (ordem de array é dado, não formatação)', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  test('ignora chaves com undefined, igual ao JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('sha256Hex', () => {
  test('gera hex de 64 caracteres conhecido', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
