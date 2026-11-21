import { Migration } from '@mikro-orm/migrations';

/**
 * A reivindicação da outbox procura o evento mais antigo pendente de cada
 * carteira (distinct on aggregate_id, ordenado por occurred_at). Sem um
 * índice nessa ordem, o Postgres varre e ordena todos os pendentes a cada
 * rodada: medido com 20 mil pendentes, ~70 ms por reivindicação, crescendo
 * com o acúmulo. Com o índice parcial, ele lê só a cabeça de cada carteira.
 */
export class Migration20261121130000_indice_da_outbox_por_carteira extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index ix_outbox_messages_pending_by_aggregate
        on outbox_messages (aggregate_id, occurred_at, id)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists ix_outbox_messages_pending_by_aggregate;');
  }
}
