/**
 * Sabotagem dirigida: `bun run test:mutation`.
 *
 * Testes verdes só provam alguma coisa se ficarem vermelhos quando a garantia
 * quebra. Este script quebra de propósito, uma de cada vez, cada garantia
 * importante do sistema, roda só os testes que deveriam perceber e confere
 * que eles falham. Depois restaura o arquivo original.
 *
 * Diferente de uma ferramenta de mutação genérica (que troca operadores ao
 * acaso), aqui cada sabotagem é escolhida a dedo: é a regressão que mais
 * custaria caro se passasse despercebida.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

interface Sabotage {
  guarantee: string;
  file: string;
  find: string;
  replace: string;
  tests: string[];
}

const SABOTAGES: Sabotage[] = [
  {
    guarantee: 'lock por carteira (SELECT ... FOR UPDATE)',
    file: 'src/wallet/infrastructure/persistence/wallet.repository.ts',
    find: '{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true }',
    replace: '{ refresh: true }',
    tests: ['test/concurrency/same-wallet.test.ts'],
  },
  {
    guarantee: 'carteira recusa débito maior que o saldo',
    file: 'src/wallet/domain/wallet.ts',
    find: 'if (this._balance.isLessThan(movement.money)) {',
    replace: 'if (false) {',
    tests: ['test/unit/wallet/wallet.test.ts'],
  },
  {
    guarantee: 'mesma chave com outro conteúdo é conflito, não replay',
    file: 'src/wagering/application/submit-wager-transaction.ts',
    find: 'if (sameKey?.matchesPayload(candidate.payloadHash)) {',
    replace: 'if (sameKey) {',
    tests: ['test/integration/submit-wager.test.ts'],
  },
  {
    guarantee: 'referência revertida só uma vez',
    file: 'src/wagering/application/wager-processor.ts',
    find: 'if (await tx.transactions.hasProcessedReversal(reference.id)) {',
    replace: 'if (false) {',
    tests: ['test/integration/submit-wager.test.ts'],
  },
  {
    guarantee: 'aposta liquidada não aceita nova liquidação nem reembolso',
    file: 'src/wagering/application/wager-processor.ts',
    find: '(await tx.transactions.isSettled(reference.id))',
    replace: 'false',
    tests: ['test/integration/submit-wager.test.ts'],
  },
  {
    guarantee: 'saldo de carteira de outro jogador não é exposto nem movimentado',
    file: 'src/wagering/application/wager-processor.ts',
    find: 'if (wallet.playerId !== transaction.playerId) {',
    replace: 'if (false) {',
    tests: ['test/integration/submit-wager.test.ts'],
  },
  {
    guarantee: 'dinheiro só com duas casas decimais na entrada',
    file: 'src/shared/domain/money.ts',
    find: 'const AMOUNT_PATTERN = /^(0|[1-9]\\d{0,16})\\.\\d{2}$/;',
    replace: 'const AMOUNT_PATTERN = /^(0|[1-9]\\d{0,16})\\.\\d{2,3}$/;',
    tests: ['test/unit/shared/money.test.ts'],
  },
  {
    guarantee: 'ledger imutável no banco (trigger)',
    file: 'migrations/Migration20261120120000_esquema_inicial.ts',
    find:
      "        raise exception 'ledger é imutável: % bloqueado em wallet_ledger_entries', tg_op\n" +
      "          using errcode = 'P0001';",
    replace: '        return coalesce(new, old);',
    tests: ['test/integration/schema-constraints.test.ts'],
  },
  {
    guarantee: 'reconciliação confere o hash de cada lançamento',
    file: 'src/wallet/domain/ledger-chain.ts',
    find: '!entry.hasValidHash()',
    replace: 'false',
    tests: ['test/unit/wallet/ledger-chain.test.ts'],
  },
  {
    guarantee: 'duas instâncias nunca publicam o mesmo evento da outbox (SKIP LOCKED)',
    file: 'src/messaging/infrastructure/outbox-relay.ts',
    find: 'for update of o skip locked',
    replace: '',
    tests: ['test/integration/outbox-relay.test.ts'],
  },
  {
    guarantee: 'provedor vem do token, não do corpo da requisição',
    file: 'src/wagering/infrastructure/http/wagering.controller.ts',
    find: 'principal?.assertActsAs(body.providerId);',
    replace: '',
    tests: ['test/integration/auth.test.ts'],
  },
];

const TIMEOUT_MS = 10 * 60_000;
const LOG_DIR = 'test/mutation/results';
const originals = new Map<string, string>();

async function main(): Promise<void> {
  const files = [...new Set(SABOTAGES.map((s) => s.file))];
  assertNoLocalChanges(files);
  for (const file of files) originals.set(file, await Bun.file(file).text());
  for (const s of SABOTAGES) assertSingleOccurrence(s, originals.get(s.file) ?? '');

  // Linha de base: sem sabotagem, os testes precisam passar. Senão "o teste
  // falhou" não diria nada sobre a sabotagem.
  const allTests = [...new Set(SABOTAGES.flatMap((s) => s.tests))];
  log(`linha de base: ${allTests.length} arquivos de teste sem sabotagem...`);
  if (!(await testsPass(allTests, 'linha-de-base'))) {
    throw new Error(`A suíte não está verde sem sabotagem. Saída em ${LOG_DIR}/linha-de-base.log`);
  }

  const results: Array<{ sabotage: Sabotage; detected: boolean; seconds: number }> = [];
  for (const [index, sabotage] of SABOTAGES.entries()) {
    log(`[${index + 1}/${SABOTAGES.length}] sabotando: ${sabotage.guarantee}`);
    const original = originals.get(sabotage.file) ?? '';
    const started = performance.now();
    try {
      await Bun.write(sabotage.file, original.replace(sabotage.find, sabotage.replace));
      const detected = !(await testsPass(sabotage.tests, `sabotagem-${index + 1}`));
      results.push({ sabotage, detected, seconds: (performance.now() - started) / 1000 });
      log(detected ? '   detectada' : '   PASSOU DESPERCEBIDA');
    } finally {
      await Bun.write(sabotage.file, original);
    }
  }

  const detected = results.filter((r) => r.detected).length;
  console.info(
    [
      '',
      '| # | Garantia sabotada | Testes que deveriam perceber | Resultado |',
      '|---|---|---|---|',
      ...results.map(
        (r, i) =>
          `| ${i + 1} | ${r.sabotage.guarantee} | ${r.sabotage.tests.map((t) => `\`${t}\``).join(', ')} | ` +
          `${r.detected ? 'detectada' : '**passou despercebida**'} (${r.seconds.toFixed(0)}s) |`,
      ),
      '',
      `${detected} de ${results.length} sabotagens detectadas.`,
      '',
    ].join('\n'),
  );
  if (detected !== results.length) process.exitCode = 1;
}

// A saída de cada rodada fica guardada: "falhou" sem o motivo não serve para nada.
async function testsPass(tests: string[], logName: string): Promise<boolean> {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = Bun.file(`${LOG_DIR}/${logName}.log`);
  const child = Bun.spawn(['bun', 'test', ...tests], { stdout: logFile, stderr: logFile });
  const timeout = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
  const code = await child.exited;
  clearTimeout(timeout);
  return code === 0;
}

function assertNoLocalChanges(files: string[]): void {
  const diff = Bun.spawnSync(['git', 'status', '--porcelain', '--', ...files]);
  if (diff.stdout.toString().trim()) {
    throw new Error(
      'Há alterações não commitadas nos arquivos que seriam sabotados. Commite ou descarte antes.',
    );
  }
}

function assertSingleOccurrence(sabotage: Sabotage, content: string): void {
  const count = content.split(sabotage.find).length - 1;
  if (count !== 1) {
    throw new Error(
      `A sabotagem "${sabotage.guarantee}" espera 1 ocorrência em ${sabotage.file}, achou ${count}. ` +
        'O código mudou: atualize o trecho em test/mutation/run.ts.',
    );
  }
}

/** Ctrl+C no meio não pode deixar código sabotado para trás. */
function restoreAllSync(): void {
  for (const [file, content] of originals) writeFileSync(file, content);
}

process.on('SIGINT', () => {
  restoreAllSync();
  process.exit(130);
});

function log(message: string): void {
  console.info(`[sabotagem] ${message}`);
}

await main().catch((error) => {
  restoreAllSync();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
