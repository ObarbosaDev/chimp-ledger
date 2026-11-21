import { expect } from 'bun:test';
import type { TestStack } from './test-stack';

/**
 * A invariante que fecha todo teste: o saldo guardado na carteira é igual ao
 * saldo reconstruído somando o ledger, e a versão bate com o último lançamento.
 * Faço a conta no próprio Postgres (NUMERIC), sem passar por number.
 */
export async function assertLedgerInvariant(stack: TestStack, walletId: string): Promise<void> {
  const [row] = await stack.sql<{
    stored: string;
    rebuilt: string;
    version: number;
    last_sequence: number | null;
  }>(
    `select w.balance::text as stored,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19,2)::text as rebuilt,
            w.version,
            max(e.sequence) as last_sequence
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = $1
      group by w.id`,
    [walletId],
  );
  expect(row).toBeDefined();
  expect(row?.rebuilt).toBe(row?.stored);
  if (row?.last_sequence !== null) {
    expect(row?.last_sequence).toBe(row?.version);
  }
}
