import { Migration } from '@mikro-orm/migrations';

const TRIGGER_FUNCTIONS = [
  'forbid_ledger_change()',
  'check_ledger_chain()',
  'check_wallet_update()',
  'check_wallet_matches_ledger()',
  'check_wager_transaction_update()',
];

/**
 * As funções de trigger usam os nomes das tabelas sem schema. Por padrão o
 * Postgres procura primeiro em pg_temp, então uma sessão poderia criar uma
 * tabela temporária `wallet_ledger_entries` e fazer a checagem de
 * encadeamento ler dados falsos. Fixar o search_path (com pg_temp por
 * último) faz as funções sempre enxergarem as tabelas reais.
 */
export class Migration20261121100000_search_path_das_funcoes extends Migration {
  override async up(): Promise<void> {
    for (const fn of TRIGGER_FUNCTIONS) {
      this.addSql(`alter function ${fn} set search_path = pg_catalog, public, pg_temp;`);
    }
  }

  override async down(): Promise<void> {
    for (const fn of TRIGGER_FUNCTIONS) {
      this.addSql(`alter function ${fn} reset search_path;`);
    }
  }
}
