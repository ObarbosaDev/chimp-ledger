import { Migration } from '@mikro-orm/migrations';

/**
 * Quando a transação é recusada porque a carteira não é do jogador informado,
 * o saldo daquela carteira não pode ficar guardado na transação: ele voltaria
 * na resposta, na consulta e no evento para quem não é dono dela.
 *
 * A regra antiga exigia snapshot de saldo em toda transação PROCESSED ou
 * REJECTED. A nova mantém a exigência, com uma exceção explícita para
 * WALLET_PLAYER_MISMATCH, em que o snapshot passa a ser proibido.
 */
export class Migration20261121110000_saldo_oculto_em_carteira_alheia extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_result_snapshot_check,
        add constraint wager_transactions_result_snapshot_check check (
          case
            when status = 'PROCESSED' then result_balance is not null
            when status = 'REJECTED' and failure_code = 'WALLET_PLAYER_MISMATCH' then result_balance is null
            when status = 'REJECTED' then result_balance is not null
            else result_balance is null
          end
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_result_snapshot_check,
        add constraint wager_transactions_result_snapshot_check
          check ((status in ('PROCESSED', 'REJECTED')) = (result_balance is not null));
    `);
  }
}
