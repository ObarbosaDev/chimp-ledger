import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { startTestStack, type TestStack } from '../support/test-stack';

// Aqui eu falo direto com o banco, sem passar pelo domínio. A ideia é provar
// que as garantias continuam de pé mesmo se alguém (ou um bug) pular a
// aplicação e mandar SQL na mão.
describe('esquema: restrições e triggers', () => {
  let stack: TestStack;
  let owner: pg.PoolClient;

  beforeAll(async () => {
    stack = await startTestStack();
    await runMigrations(stack.migratorUrl, 'up');
    owner = await stack.ownerPool.connect();
    await owner.query(`insert into providers (id, currencies) values ('provider-a', '{BRL}')`);
  }, 180_000);

  afterAll(async () => {
    owner?.release();
    await stack?.stop();
  });

  beforeEach(async () => {
    await owner.query('rollback').catch(() => undefined);
  });

  const genesis = (walletId: string) =>
    owner
      .query<{ h: string }>(`select encode(sha256(('genesis:' || $1)::bytea), 'hex') as h`, [
        walletId,
      ])
      .then((r) => r.rows[0]?.h ?? '');

  // Monta uma carteira válida pelo caminho "oficial": carteira + OPENING +
  // lançamento de sequência 1, tudo na mesma transação.
  async function seedWallet(balance = '100.00') {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const openingId = randomUUID();
    const head = await genesis(walletId);
    const entryHash = 'e'.repeat(64);
    await owner.query('begin');
    await owner.query(
      `insert into wallets (id, player_id, currency, balance, version, ledger_head_hash, created_at, updated_at)
       values ($1, $2, 'BRL', $3, 1, $4, now(), now())`,
      [walletId, playerId, balance, entryHash],
    );
    await owner.query(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance, processed_at, created_at)
       values ($1, 'internal', 'opening:' || $2::text, 'internal:opening:' || $2::text, '', $2::uuid, $3, 'internal', 'internal',
         'OPENING', $4, 'BRL', 'PROCESSED', $4, now(), now())`,
      [openingId, walletId, playerId, balance],
    );
    await owner.query(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, sequence, direction, amount, currency,
         balance_before, balance_after, prev_hash, entry_hash, created_at)
       values ($1, $2, $3, 1, 'CREDIT', $4, 'BRL', 0, $4, $5, $6, now())`,
      [randomUUID(), walletId, openingId, balance, head, entryHash],
    );
    await owner.query('commit');
    return { walletId, playerId, openingId, entryHash };
  }

  async function insertBet(walletId: string, playerId: string, amount = '10.00') {
    const id = randomUUID();
    const ext = `bet-${id}`;
    await owner.query(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
       values ($1, 'provider-a', $2, 'provider-a:' || $2, 'h', $3, $4, 'r1', 'g1', 'BET', $5, 'BRL', 'PENDING', now())`,
      [id, ext, walletId, playerId, amount],
    );
    return { id, ext };
  }

  const expectError = async (sql: Promise<unknown>, pattern: RegExp) => {
    let message = '';
    try {
      await sql;
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(pattern);
  };

  test('carteira válida (carteira + OPENING + lançamento) é aceita', async () => {
    const { walletId } = await seedWallet();
    const { rows } = await owner.query('select balance, version from wallets where id = $1', [
      walletId,
    ]);
    expect(rows[0]).toEqual({ balance: '100.00', version: 1 });
  });

  test('segunda carteira para o mesmo jogador e moeda é recusada', async () => {
    const { playerId } = await seedZeroWallet();
    await expectError(
      owner.query(
        `insert into wallets (id, player_id, currency, balance, version, ledger_head_hash, created_at, updated_at)
         values ($1, $2, 'BRL', 0, 1, 'x', now(), now())`,
        [randomUUID(), playerId],
      ),
      /wallets_player_id_currency_key/,
    );
  });

  async function seedZeroWallet() {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await owner.query(
      `insert into wallets (id, player_id, currency, balance, version, ledger_head_hash, created_at, updated_at)
       values ($1, $2, 'BRL', 0, 1, $3, now(), now())`,
      [walletId, playerId, await genesis(walletId)],
    );
    return { walletId, playerId };
  }

  test('saldo negativo é recusado pelo CHECK', async () => {
    const { walletId } = await seedWallet();
    await expectError(
      owner.query('update wallets set balance = -1, version = 2 where id = $1', [walletId]),
      /wallets_balance_check/,
    );
  });

  test('mudar saldo sem lançamento no ledger falha no commit', async () => {
    const { walletId } = await seedWallet();
    await owner.query('begin');
    await owner.query('update wallets set balance = 90, version = 2 where id = $1', [walletId]);
    await expectError(owner.query('commit'), /saldo sem lançamento/);
  });

  test('versão só sobe de um em um e só quando o saldo muda', async () => {
    const { walletId } = await seedWallet();
    await expectError(
      owner.query('update wallets set version = 5 where id = $1', [walletId]),
      /versão/,
    );
  });

  test('ledger não aceita UPDATE nem DELETE (nem do dono da tabela)', async () => {
    const { walletId } = await seedWallet();
    await expectError(
      owner.query('update wallet_ledger_entries set amount = 1 where wallet_id = $1', [walletId]),
      /imutável/,
    );
    await expectError(
      owner.query('delete from wallet_ledger_entries where wallet_id = $1', [walletId]),
      /imutável/,
    );
  });

  test('usuário da aplicação nem tem permissão de UPDATE no ledger', async () => {
    const app = await stack.appPool.connect();
    try {
      await expectError(
        app.query('update wallet_ledger_entries set amount = 1'),
        /permission denied/,
      );
    } finally {
      app.release();
    }
  });

  test('lançamento com conta que não fecha é recusado', async () => {
    const { walletId, playerId, entryHash } = await seedWallet();
    const bet = await insertBet(walletId, playerId);
    await expectError(
      owner.query(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, sequence, direction, amount, currency,
           balance_before, balance_after, prev_hash, entry_hash, created_at)
         values ($1, $2, $3, 2, 'DEBIT', 10, 'BRL', 100, 95, $4, $5, now())`,
        [randomUUID(), walletId, bet.id, entryHash, 'f'.repeat(64)],
      ),
      /wallet_ledger_entries_arithmetic_check/,
    );
  });

  test('lançamento que não encadeia no anterior é recusado', async () => {
    const { walletId, playerId } = await seedWallet();
    const bet = await insertBet(walletId, playerId);
    await expectError(
      owner.query(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, sequence, direction, amount, currency,
           balance_before, balance_after, prev_hash, entry_hash, created_at)
         values ($1, $2, $3, 2, 'DEBIT', 10, 'BRL', 100, 90, $4, $5, now())`,
        [randomUUID(), walletId, bet.id, '0'.repeat(64), 'f'.repeat(64)],
      ),
      /não encadeia/,
    );
  });

  test('dois lançamentos com a mesma sequência na carteira são recusados', async () => {
    const { walletId, playerId, openingId, entryHash } = await seedWallet();
    await insertBet(walletId, playerId);
    await expectError(
      owner.query(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, sequence, direction, amount, currency,
           balance_before, balance_after, prev_hash, entry_hash, created_at)
         values ($1, $2, $3, 1, 'CREDIT', 100, 'BRL', 0, 100, $4, $5, now())`,
        [randomUUID(), walletId, openingId, await genesis(walletId), entryHash],
      ),
      /wallet_ledger_entries_wallet_id_(sequence|transaction_id)_key|não encadeia/,
    );
  });

  test('transação em estado final não muda mais', async () => {
    const { walletId, playerId } = await seedWallet();
    const bet = await insertBet(walletId, playerId);
    await owner.query(
      `update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS',
         result_balance = 100, processed_at = now() where id = $1`,
      [bet.id],
    );
    await expectError(
      owner.query(`update wager_transactions set status = 'PROCESSED' where id = $1`, [bet.id]),
      /estado final/,
    );
  });

  test('a mesma referência não pode ser revertida duas vezes, nem trocando REFUND por ROLLBACK', async () => {
    const { walletId, playerId } = await seedWallet();
    const bet = await insertBet(walletId, playerId);
    const reversal = (kind: string) =>
      owner.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
           reference_transaction_id, status, result_balance, processed_at, created_at)
         values ($1, 'provider-a', $2, 'provider-a:' || $2, 'h', $3, $4, 'r1', 'g1', $5, 10, 'BRL', $6, $7,
           'PROCESSED', 100, now(), now())`,
        [randomUUID(), `${kind}-${randomUUID()}`, walletId, playerId, kind, bet.ext, bet.id],
      );
    await reversal('REFUND');
    await expectError(reversal('ROLLBACK'), /uq_wager_transactions_reversal_once/);
  });

  test('chave de idempotência é única por provedor', async () => {
    const { walletId, playerId } = await seedWallet();
    const bet = await insertBet(walletId, playerId);
    await expectError(
      owner.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
         values ($1, 'provider-a', 'outro-ext', 'provider-a:' || $2, 'h', $3, $4, 'r1', 'g1', 'BET', 5, 'BRL',
           'PENDING', now())`,
        [randomUUID(), bet.ext, walletId, playerId],
      ),
      /wager_transactions_provider_id_idempotency_key_key/,
    );
  });

  test('OPENING só existe com provedor interno', async () => {
    const { walletId, playerId } = await seedWallet();
    await expectError(
      owner.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance, processed_at, created_at)
         values ($1, 'provider-a', 'x', 'provider-a:x', 'h', $2, $3, 'r', 'g', 'OPENING', 1, 'BRL',
           'PROCESSED', 1, now(), now())`,
        [randomUUID(), walletId, playerId],
      ),
      /wager_transactions_opening_internal_check/,
    );
  });

  test('inbox recusa a mesma mensagem duas vezes para o mesmo consumidor', async () => {
    const insert = () =>
      owner.query(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         values ('wager-consumer', 'msg-dup', 'h', now(), now())`,
      );
    await insert();
    await expectError(insert(), /inbox_messages_pkey/);
  });

  test('todas as migrações descem e sobem de novo sem sobrar nada', async () => {
    owner.release();
    await runMigrations(stack.migratorUrl, 'reset');
    const { rows } = await stack.ownerPool.query(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_name in ('wallets', 'wallet_ledger_entries')`,
    );
    expect(rows[0].n).toBe(0);
    await runMigrations(stack.migratorUrl, 'up');
    owner = await stack.ownerPool.connect();
  });
});
