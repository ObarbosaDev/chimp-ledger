import { describe, expect, test } from 'bun:test';
import { findDomainViolations, scanDomainFolder } from './dependency-rule';

// O domínio é o único lugar que decide sobre dinheiro. Se ele começar a
// importar framework, ORM ou runtime, a regra de negócio vira refém da infra.
describe('regra de dependência do domínio', () => {
  test('detecta import proibido num arquivo de domínio', () => {
    const violations = findDomainViolations([
      { path: 'src/wallet/domain/wallet.ts', source: "import { Entity } from '@mikro-orm/core';" },
      {
        path: 'src/wallet/domain/ok.ts',
        source: "import { Money } from '../../shared/domain/money';",
      },
      { path: 'src/wallet/domain/x.ts', source: "import { Injectable } from '@nestjs/common';" },
      { path: 'src/wallet/domain/y.ts', source: "import x from '../infrastructure/repo';" },
      { path: 'src/wallet/domain/z.ts', source: "import { $ } from 'bun';" },
    ]);
    expect(violations.map((v) => v.path)).toEqual([
      'src/wallet/domain/wallet.ts',
      'src/wallet/domain/x.ts',
      'src/wallet/domain/y.ts',
      'src/wallet/domain/z.ts',
    ]);
  });

  test('nenhum arquivo de src/**/domain viola a regra', async () => {
    const files = await scanDomainFolder('src');
    expect(findDomainViolations(files)).toEqual([]);
  });
});
