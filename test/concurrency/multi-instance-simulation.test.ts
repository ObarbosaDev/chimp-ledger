import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { assertLedgerInvariant } from '../support/invariants';
import { startTestStack, type TestStack } from '../support/test-stack';
import { type Fleet, startFleet } from './instances';

/**
 * Simulação com 3 processos reais da API disputando as mesmas carteiras.
 *
 * Não dá para prever o saldo final exato: depende de qual aposta ganhou a
 * corrida em cada momento. Então eu não comparo com um valor esperado: eu
 * verifico propriedades que precisam valer em QUALQUER ordem de execução.
 * Se alguma quebrar, a seed impressa reproduz a mesma sequência de operações.
 */
const SEED = Number(process.env.SIM_SEED ?? Date.now() % 1_000_000);
const INSTANCES = 3;
const WALLETS = 4;
const OPERATIONS = 400;

describe(`simulação multi-instância (seed ${SEED})`, () => {
  let stack: TestStack;
  let fleet: Fleet;

  beforeAll(async () => {
    stack = await startTestStack();
    await runMigrations(stack.migratorUrl, 'up');
    await stack.sql(`insert into providers (id, currencies) values ('provider-a', '{BRL}')`);
    fleet = await startFleet(stack, INSTANCES);
  }, 240_000);

  afterAll(async () => {
    await fleet?.stop();
    await stack?.stop();
  });

  test('propriedades financeiras valem com 3 instâncias, duplicatas e desordem', async () => {
    const random = mulberry32(SEED);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
    const instanceUrl = () => pick(fleet.instances).url;

    const wallets = [];
    for (let i = 0; i < WALLETS; i++) {
      const playerId = randomUUID();
      const res = await fetch(`${instanceUrl()}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '500.00', currency: 'BRL' } }),
      });
      const body = (await res.json()) as { id: string };
      wallets.push({ walletId: body.id, playerId, bets: [] as string[], wins: [] as string[] });
    }

    // Gero as operações antes de enviar, para a seed reproduzir tudo.
    const operations: Record<string, unknown>[] = [];
    for (let i = 0; i < OPERATIONS; i++) {
      const w = pick(wallets);
      const ext = `sim-${SEED}-${i}`;
      const base = {
        providerId: 'provider-a',
        externalTransactionId: ext,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: `round-${i % 7}`,
        gameId: 'fortune-chimp',
      };
      const roll = random();
      const amount = `${1 + Math.floor(random() * 60)}.${String(Math.floor(random() * 100)).padStart(2, '0')}`;

      if (roll < 0.55 || w.bets.length === 0) {
        w.bets.push(ext);
        operations.push({
          ...base,
          roundId: 'round-x',
          kind: 'BET',
          money: { amount, currency: 'BRL' },
        });
      } else if (roll < 0.75) {
        w.wins.push(ext);
        operations.push({
          ...base,
          roundId: 'round-x',
          kind: 'WIN',
          money: { amount, currency: 'BRL' },
        });
      } else if (roll < 0.85) {
        operations.push({ ...base, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } });
      } else {
        // Reversão de algo que já foi gerado. O valor pode não bater e a
        // referência pode ainda não ter sido enviada (desordem): tudo isso
        // é esperado e precisa ser tratado sem quebrar invariante.
        const kind = random() < 0.5 ? 'REFUND' : 'ROLLBACK';
        const target = kind === 'REFUND' ? pick(w.bets) : pick([...w.bets, ...w.wins]);
        const referenced = operations.find((op) => op.externalTransactionId === target) as
          | { money: unknown }
          | undefined;
        operations.push({
          ...base,
          roundId: 'round-x',
          kind,
          money: random() < 0.8 && referenced ? referenced.money : { amount, currency: 'BRL' },
          referenceExternalTransactionId: target,
        });
      }
    }

    // Embaralho a ordem de envio e duplico ~20% das operações.
    const sends = [...operations];
    for (const op of operations) if (random() < 0.2) sends.push(op);
    for (let i = sends.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [sends[i], sends[j]] = [
        sends[j] as Record<string, unknown>,
        sends[i] as Record<string, unknown>,
      ];
    }

    const responses = new Map<string, unknown[]>();
    const statuses: number[] = [];
    let retries = 0;

    const send = async (op: Record<string, unknown>) => {
      const key = `provider-a:${op.externalTransactionId}`;
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await fetch(`${instanceUrl()}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify(op),
        });
        // 503 é o contrato de "tenta de novo" (ex.: lock_timeout). É o que
        // o provedor faria, então o teste faz igual.
        if (res.status === 503) {
          retries++;
          await Bun.sleep(50);
          continue;
        }
        statuses.push(res.status);
        const body = (await res.json()) as { transactionId: string; status: string };
        responses.set(key, [...(responses.get(key) ?? []), body]);
        return;
      }
      throw new Error(`Desisti de ${key} depois de 10 tentativas`);
    };

    // Ondas de 40 requisições simultâneas espalhadas nas 3 instâncias.
    for (let i = 0; i < sends.length; i += 40) {
      await Promise.all(sends.slice(i, i + 40).map(send));
    }

    // 1. Nenhuma resposta fora do contrato (nada de 500).
    expect(statuses.every((s) => [200, 201, 202, 409, 422].includes(s))).toBe(true);

    // 2. Cada chave virou exatamente uma transação, e todas as respostas da
    //    mesma chave apontam para ela.
    for (const [key, bodies] of responses) {
      const ids = new Set((bodies as { transactionId: string }[]).map((b) => b.transactionId));
      expect({ key, ids: ids.size }).toEqual({ key, ids: 1 });
    }
    const [{ dup }] = (await stack.sql<{ dup: number }>(
      `select count(*)::int as dup from (
         select provider_id, idempotency_key from wager_transactions
          group by 1, 2 having count(*) > 1) d`,
    )) as [{ dup: number }];
    expect(dup).toBe(0);

    for (const w of wallets) {
      // 3. Saldo materializado == soma do ledger, versão == último lançamento.
      await assertLedgerInvariant(stack, w.walletId);

      // 4. Saldo também bate com as transações PROCESSED (fonte independente
      //    do ledger): abertura + créditos − débitos.
      const [row] = await stack.sql<{ stored: string; from_transactions: string }>(
        `select w.balance::text as stored,
                (select coalesce(sum(case
                    when t.kind in ('OPENING', 'WIN', 'REFUND') then t.amount
                    when t.kind = 'BET' then -t.amount
                    when t.kind = 'ROLLBACK' and r.kind = 'BET' then t.amount
                    when t.kind = 'ROLLBACK' then -t.amount
                    else 0 end), 0)::numeric(19,2)::text
                   from wager_transactions t
                   left join wager_transactions r on r.id = t.reference_transaction_id
                  where t.wallet_id = w.id and t.status = 'PROCESSED') as from_transactions
           from wallets w where w.id = $1`,
        [w.walletId],
      );
      expect(row?.from_transactions).toBe(row?.stored);
    }

    // 5. Nenhuma referência revertida duas vezes.
    const [{ twice }] = (await stack.sql<{ twice: number }>(
      `select count(*)::int as twice from (
         select reference_transaction_id from wager_transactions
          where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
          group by 1 having count(*) > 1) d`,
    )) as [{ twice: number }];
    expect(twice).toBe(0);

    console.info(
      `[simulação] seed=${SEED} envios=${sends.length} retries503=${retries} ` +
        `status=${JSON.stringify(countBy(statuses))}`,
    );
  }, 240_000);
});

function countBy(values: number[]): Record<number, number> {
  return values.reduce<Record<number, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

// Gerador pseudoaleatório pequeno e determinístico: mesma seed, mesma sequência.
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
