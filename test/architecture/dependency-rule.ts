import { Glob } from 'bun';

export interface SourceFile {
  path: string;
  source: string;
}

export interface Violation {
  path: string;
  importedFrom: string;
}

// O que o domínio nunca pode conhecer. Não usei parser de TypeScript de
// propósito: olhar o especificador dos imports (estáticos e dinâmicos) já
// cobre o que eu quero vigiar, e o teste continua simples de entender.
const FORBIDDEN = [/^@nestjs\//, /^@mikro-orm\//, /^bun(:|$)/, /\/infrastructure(\/|$)/];
const IMPORT_SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

export function findDomainViolations(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (FORBIDDEN.some((rule) => rule.test(specifier))) {
        violations.push({ path: file.path, importedFrom: specifier });
      }
    }
  }
  return violations;
}

export async function scanDomainFolder(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Glob(`${root}/**/domain/**/*.ts`).scan('.')) {
    files.push({ path, source: await Bun.file(path).text() });
  }
  return files;
}
