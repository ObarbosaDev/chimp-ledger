import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { cpus, type as osType, release, totalmem } from 'node:os';
import { ensureQueues } from '../../src/messaging/infrastructure/sqs-topology';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { freePort, startFleet } from '../concurrency/instances';
import { LOCALSTACK_IMAGE, POSTGRES_IMAGE, startTestStack } from '../support/test-stack';
import { type LatencySummary, summarize } from './stats';

/**
 * Teste de carga: `bun run test:load`.
 *
 * Sobe a mesma topologia dos testes de concorrência (Postgres e LocalStack em
 * containers, 3 processos da API e 1 worker) e roda dois cenários:
 *
 * - distribuído: muitas carteiras, mede vazão e latência do caminho normal;
 * - carteira quente: todos os clientes na mesma carteira, mede o custo do
 *   lock por carteira e os conflitos.
 *
 * Laço fechado: cada cliente virtual só envia a próxima requisição depois da
 * resposta da anterior. Assim a vazão medida é a que o sistema sustenta, e a
 * latência não fica inflada por fila do próprio gerador.
 *
 * No fim, confere a invariante financeira em todas as carteiras: teste de
 * carga que não confere o dinheiro mede velocidade, não correção.
 */

const config = {
  instances: intEnv('LOAD_INSTANCES', 3),
  concurrency: intEnv('LOAD_CONCURRENCY', 48),
  durationSeconds: intEnv('LOAD_DURATION_S', 30),
  wallets: intEnv('LOAD_WALLETS', 200),
  seed: intEnv('LOAD_SEED', 20261121),
};

interface PhaseResult {
  name: string;
  wallets: number;
  concurrency: number;
  elapsedSeconds: number;
  requests: number;
  throughputRps: number;
  processedPerSecond: number;
  statuses: Record<string, number>;
  errorRate: number;
  latencyMs: LatencySummary;
  lockConflicts: number;
}

interface SentOperation {
  body: string;
  key: string;
}

async function main(): Promise<void> {
  log(`subindo ambiente (${config.instances} instâncias da API + 1 worker)...`);
  const stack = await startTestStack();
  await runMigrations(stack.migratorUrl, 'up');
  await stack.sql(`insert into providers (id, currencies) values ('provider-a', '{BRL}')`);
  await ensureQueues(stack.sqs, stack.queueNames);

  const fleet = await startFleet(stack, config.instances);
  const workerPort = await freePort();
  const worker = Bun.spawn(['bun', 'src/main.worker.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: stack.appUrl,
      SQS_ENDPOINT: stack.sqsEndpoint,
      WORKER_HTTP_PORT: String(workerPort),
      LOG_LEVEL: 'silent',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  await waitFor(async () => (await fetch(`${workerUrl}/health/live`)).ok);

  const urls = fleet.instances.map((i) => i.url);
  const lagSamples: number[] = [];
  const sampler = setInterval(async () => {
    const lag = metricSum(await scrape(workerUrl), 'outbox_lag_seconds');
    if (Number.isFinite(lag)) lagSamples.push(lag);
  }, 1_000);

  try {
    log(`abrindo ${config.wallets} carteiras...`);
    const distributed = await openWallets(urls, config.wallets, '5000.00');
    const hot = await openWallets(urls, 1, '1000000.00');

    const phases = [
      await runPhase('distribuído', urls, distributed),
      await runPhase('carteira quente', urls, hot),
    ];

    log('esperando a outbox esvaziar...');
    const drainStarted = performance.now();
    await waitFor(async () => {
      const [row] = await stack.sql<{ pending: number }>(
        'select count(*)::int as pending from outbox_messages where published_at is null',
      );
      return row?.pending === 0;
    }, 120_000);
    const drainSeconds = (performance.now() - drainStarted) / 1000;
    clearInterval(sampler);

    const invariants = await checkInvariants(stack.sql.bind(stack));
    const report = {
      generatedAt: new Date().toISOString(),
      environment: environment(),
      config,
      phases,
      outbox: {
        maxLagSeconds: lagSamples.length ? Math.max(...lagSamples) : 0,
        samples: lagSamples.length,
        drainSecondsAfterLoad: drainSeconds,
      },
      invariants,
    };

    mkdirSync('test/load/results', { recursive: true });
    const file = `test/load/results/carga-${report.generatedAt.replaceAll(':', '-')}.json`;
    await Bun.write(file, JSON.stringify(report, null, 2));
    console.info(renderMarkdown(report));
    log(`resultado completo em ${file}`);

    if (!invariants.ok) process.exitCode = 1;
  } finally {
    clearInterval(sampler);
    worker.kill();
    await fleet.stop();
    await stack.stop();
  }
}

async function runPhase(
  name: string,
  urls: string[],
  wallets: Array<{ walletId: string; playerId: string }>,
): Promise<PhaseResult> {
  log(`cenário "${name}": ${config.concurrency} clientes por ${config.durationSeconds}s...`);
  const conflictsBefore = await lockConflicts(urls);
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const deadline = performance.now() + config.durationSeconds * 1000;
  const started = performance.now();

  const client = async (index: number) => {
    const random = mulberry32(config.seed + index * 7919);
    const sent: SentOperation[] = [];
    let request = 0;
    while (performance.now() < deadline) {
      const op = nextOperation(random, wallets, sent);
      const url = urls[(index + request++) % urls.length];
      const t0 = performance.now();
      let status: string;
      try {
        const res = await fetch(`${url}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': op.key },
          body: op.body,
        });
        await res.arrayBuffer();
        status = String(res.status);
      } catch {
        status = 'erro-de-rede';
      }
      latencies.push(performance.now() - t0);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, (_, i) => client(i)));
  const elapsedSeconds = (performance.now() - started) / 1000;
  const requests = latencies.length;
  const failures = Object.entries(statuses)
    .filter(([s]) => s === 'erro-de-rede' || s.startsWith('5'))
    .reduce((sum, [, n]) => sum + n, 0);

  return {
    name,
    wallets: wallets.length,
    concurrency: config.concurrency,
    elapsedSeconds,
    requests,
    throughputRps: requests / elapsedSeconds,
    processedPerSecond: (statuses['201'] ?? 0) / elapsedSeconds,
    statuses,
    errorRate: requests ? failures / requests : 0,
    latencyMs: summarize(latencies),
    lockConflicts: (await lockConflicts(urls)) - conflictsBefore,
  };
}

/**
 * Mistura de operações: ~65% BET, ~15% WIN, ~15% LOSS e ~5% de reenvio de
 * algo que o mesmo cliente já mandou (duplicata, que precisa virar replay).
 */
function nextOperation(
  random: () => number,
  wallets: Array<{ walletId: string; playerId: string }>,
  sent: SentOperation[],
): SentOperation {
  const roll = random();
  if (roll < 0.05 && sent.length > 0) {
    return sent[Math.floor(random() * sent.length)] as SentOperation;
  }
  const w = wallets[Math.floor(random() * wallets.length)] as {
    walletId: string;
    playerId: string;
  };
  const ext = `load-${randomUUID()}`;
  const kind = roll < 0.7 ? 'BET' : roll < 0.85 ? 'WIN' : 'LOSS';
  const amount =
    kind === 'LOSS'
      ? '0.00'
      : `${1 + Math.floor(random() * 20)}.${String(Math.floor(random() * 100)).padStart(2, '0')}`;
  const op = {
    key: `provider-a:${ext}`,
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: `round-${Math.floor(random() * 1000)}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    }),
  };
  if (sent.length < 200) sent.push(op);
  return op;
}

async function openWallets(urls: string[], count: number, amount: string) {
  const wallets: Array<{ walletId: string; playerId: string }> = [];
  for (let i = 0; i < count; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - i) }, async (_, k) => {
        const playerId = randomUUID();
        const res = await fetch(`${urls[(i + k) % urls.length]}/wallets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
        });
        return { walletId: ((await res.json()) as { id: string }).id, playerId };
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

/** Invariantes financeiras sobre todas as carteiras, calculadas no Postgres. */
async function checkInvariants(sql: <T>(text: string, params?: unknown[]) => Promise<T[]>) {
  const [balances] = await sql<{ wallets: number; divergent: number }>(
    `select count(*)::int as wallets,
            count(*) filter (where w.balance <> coalesce(l.total, 0)
                               or w.ledger_sequence <> coalesce(l.entries, 0))::int as divergent
       from wallets w
       left join (select wallet_id,
                         sum(case direction when 'CREDIT' then amount else -amount end) as total,
                         count(*) as entries
                    from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id`,
  );
  const [duplicates] = await sql<{ n: number }>(
    `select count(*)::int as n from (
       select provider_id, idempotency_key from wager_transactions
        group by 1, 2 having count(*) > 1) d`,
  );
  const [negative] = await sql<{ n: number }>(
    'select count(*)::int as n from wallets where balance < 0',
  );
  return {
    wallets: balances?.wallets ?? 0,
    walletsWithDivergence: balances?.divergent ?? -1,
    duplicatedIdempotencyKeys: duplicates?.n ?? -1,
    negativeBalances: negative?.n ?? -1,
    ok: balances?.divergent === 0 && duplicates?.n === 0 && negative?.n === 0,
  };
}

async function lockConflicts(urls: string[]): Promise<number> {
  const texts = await Promise.all(urls.map(scrape));
  return texts.reduce((sum, text) => sum + metricSum(text, 'lock_conflicts_total'), 0);
}

async function scrape(baseUrl: string): Promise<string> {
  try {
    return await (await fetch(`${baseUrl}/metrics`)).text();
  } catch {
    return '';
  }
}

/** Soma todas as séries de uma métrica no formato de texto do Prometheus. */
function metricSum(text: string, name: string): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}

function environment() {
  const docker = Bun.spawnSync(['docker', 'version', '--format', '{{.Server.Version}}']);
  return {
    os: `${osType()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'desconhecida',
    cpuCores: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    bun: Bun.version,
    docker: docker.stdout.toString().trim() || 'desconhecido',
    images: { postgres: POSTGRES_IMAGE, localstack: LOCALSTACK_IMAGE },
  };
}

function renderMarkdown(report: {
  environment: ReturnType<typeof environment>;
  phases: PhaseResult[];
  outbox: { maxLagSeconds: number; drainSecondsAfterLoad: number };
  invariants: Awaited<ReturnType<typeof checkInvariants>>;
}): string {
  const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
  const rows = report.phases.map(
    (p) =>
      `| ${p.name} | ${p.wallets} | ${p.concurrency} | ${p.requests} | ${p.throughputRps.toFixed(0)} | ` +
      `${p.processedPerSecond.toFixed(0)} | ${ms(p.latencyMs.p50)} | ${ms(p.latencyMs.p95)} | ` +
      `${ms(p.latencyMs.p99)} | ${(p.errorRate * 100).toFixed(2)}% | ${p.lockConflicts} | ` +
      `${JSON.stringify(p.statuses)} |`,
  );
  return [
    '',
    '| Cenário | Carteiras | Clientes | Requisições | req/s | aplicadas/s | p50 ms | p95 ms | p99 ms | Erros | Conflitos de lock | Status |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Outbox: lag máximo ${report.outbox.maxLagSeconds.toFixed(2)}s, esvaziou ${report.outbox.drainSecondsAfterLoad.toFixed(1)}s depois do fim da carga.`,
    `Invariantes: ${report.invariants.wallets} carteiras, ${report.invariants.walletsWithDivergence} com divergência, ` +
      `${report.invariants.duplicatedIdempotencyKeys} chaves duplicadas, ${report.invariants.negativeBalances} saldos negativos.`,
    '',
  ].join('\n');
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  throw new Error(`condição não atingida em ${timeoutMs}ms`);
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function log(message: string): void {
  console.info(`[carga] ${message}`);
}

await main();
