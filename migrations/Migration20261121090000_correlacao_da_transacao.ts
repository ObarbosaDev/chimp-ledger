import { Migration } from '@mikro-orm/migrations';

/**
 * Guarda o correlationId da requisição (ou mensagem) que criou a transação.
 * Sem isso, os eventos que o varredor de pendências gera depois perdem o fio
 * com a origem e não dá para rastrear o desfecho pelo mesmo id.
 *
 * Migração nova em vez de editar a inicial: a inicial já foi aplicada e
 * publicada, e migração aplicada não se altera.
 */
export class Migration20261121090000_correlacao_da_transacao extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column correlation_id text check (length(correlation_id) between 1 and 256);
    `);
  }

  override async down(): Promise<void> {
    this.addSql('alter table wager_transactions drop column if exists correlation_id;');
  }
}
