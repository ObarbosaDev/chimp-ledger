import { Migration } from '@mikro-orm/migrations';

const SEARCH_PATH = 'set search_path = pg_catalog, public, pg_temp';

/**
 * Separa a sequência do ledger da versão da carteira.
 *
 * Antes, o número do lançamento era a versão da carteira depois do
 * movimento. Como a versão começa em 1 mesmo sem lançamento, uma carteira
 * aberta com saldo zero tinha o primeiro lançamento com sequência 2, e quem
 * lê o ledger esperando começar em 1 via um "buraco". Agora a carteira guarda
 * `ledger_sequence` (quantos lançamentos tem) e o banco exige que o primeiro
 * seja o 1 e que cada novo seja o seguinte.
 *
 * As funções são recriadas com o search_path fixo da migração anterior:
 * `create or replace` substitui as configurações da função.
 */
export class Migration20261121120000_sequencia_propria_do_ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wallets
        add column ledger_sequence integer not null default 0 check (ledger_sequence >= 0);
    `);
    this.addSql(`
      alter table wallets disable trigger trg_wallet_update;
      update wallets w
         set ledger_sequence = coalesce(
               (select max(e.sequence) from wallet_ledger_entries e where e.wallet_id = w.id), 0);
      alter table wallets enable trigger trg_wallet_update;
    `);

    this.addSql(`
      create or replace function check_ledger_chain() returns trigger language plpgsql
      ${SEARCH_PATH} as $$
      declare
        previous wallet_ledger_entries%rowtype;
      begin
        select * into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by sequence desc
         limit 1;

        if not found then
          if new.sequence <> 1
             or new.balance_before <> 0
             or new.prev_hash <> encode(sha256(('genesis:' || new.wallet_id::text)::bytea), 'hex') then
            raise exception 'lançamento não encadeia: o primeiro lançamento da carteira % precisa ter sequência 1, partir do saldo zero e do gênese', new.wallet_id;
          end if;
          return new;
        end if;

        if new.sequence <> previous.sequence + 1
           or new.prev_hash <> previous.entry_hash
           or new.balance_before <> previous.balance_after then
          raise exception 'lançamento não encadeia no anterior (carteira %, sequência % depois de %)',
            new.wallet_id, new.sequence, previous.sequence;
        end if;
        return new;
      end $$;
    `);

    this.addSql(`
      create or replace function check_wallet_update() returns trigger language plpgsql
      ${SEARCH_PATH} as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id
           or new.currency <> old.currency or new.created_at <> old.created_at then
          raise exception 'identidade da carteira % não pode mudar', old.id;
        end if;
        if new.balance <> old.balance
           and (new.version <> old.version + 1 or new.ledger_sequence <> old.ledger_sequence + 1) then
          raise exception 'versão e sequência do ledger da carteira % precisam subir exatamente 1 quando o saldo muda', old.id;
        end if;
        if new.balance = old.balance
           and (new.version <> old.version or new.ledger_sequence <> old.ledger_sequence) then
          raise exception 'versão da carteira % só muda quando o saldo muda', old.id;
        end if;
        return new;
      end $$;
    `);

    this.addSql(`
      create or replace function check_wallet_matches_ledger() returns trigger language plpgsql
      ${SEARCH_PATH} as $$
      declare
        target_wallet uuid;
        w wallets%rowtype;
        last_entry wallet_ledger_entries%rowtype;
      begin
        if tg_table_name = 'wallets' then
          target_wallet := new.id;
        else
          target_wallet := new.wallet_id;
        end if;

        select * into w from wallets where id = target_wallet;
        select * into last_entry
          from wallet_ledger_entries
         where wallet_id = target_wallet
         order by sequence desc
         limit 1;

        if not found then
          if w.balance <> 0 or w.ledger_sequence <> 0 then
            raise exception 'carteira % tem saldo sem lançamento no ledger', target_wallet;
          end if;
          return null;
        end if;

        if last_entry.sequence <> w.ledger_sequence
           or last_entry.balance_after <> w.balance
           or last_entry.entry_hash <> w.ledger_head_hash then
          raise exception 'carteira % tem saldo sem lançamento correspondente (sequência %, último lançamento %)',
            target_wallet, w.ledger_sequence, last_entry.sequence;
        end if;
        return null;
      end $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      create or replace function check_ledger_chain() returns trigger language plpgsql
      ${SEARCH_PATH} as $$
      declare
        previous wallet_ledger_entries%rowtype;
      begin
        select * into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by sequence desc
         limit 1;

        if not found then
          if new.prev_hash <> encode(sha256(('genesis:' || new.wallet_id::text)::bytea), 'hex') then
            raise exception 'lançamento não encadeia: primeiro elo precisa partir do gênese da carteira %', new.wallet_id;
          end if;
          return new;
        end if;

        if new.sequence <> previous.sequence + 1
           or new.prev_hash <> previous.entry_hash
           or new.balance_before <> previous.balance_after then
          raise exception 'lançamento não encadeia no anterior (carteira %, sequência % depois de %)',
            new.wallet_id, new.sequence, previous.sequence;
        end if;
        return new;
      end $$;
    `);

    this.addSql(`
      create or replace function check_wallet_update() returns trigger language plpgsql
      ${SEARCH_PATH} as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id
           or new.currency <> old.currency or new.created_at <> old.created_at then
          raise exception 'identidade da carteira % não pode mudar', old.id;
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'versão da carteira % precisa subir exatamente 1 quando o saldo muda', old.id;
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'versão da carteira % só muda quando o saldo muda', old.id;
        end if;
        return new;
      end $$;
    `);

    this.addSql(`
      create or replace function check_wallet_matches_ledger() returns trigger language plpgsql
      ${SEARCH_PATH} as $$
      declare
        target_wallet uuid;
        w wallets%rowtype;
        last_entry wallet_ledger_entries%rowtype;
      begin
        if tg_table_name = 'wallets' then
          target_wallet := new.id;
        else
          target_wallet := new.wallet_id;
        end if;

        select * into w from wallets where id = target_wallet;
        select * into last_entry
          from wallet_ledger_entries
         where wallet_id = target_wallet
         order by sequence desc
         limit 1;

        if not found then
          if w.balance <> 0 then
            raise exception 'carteira % tem saldo sem lançamento no ledger', target_wallet;
          end if;
          return null;
        end if;

        if last_entry.sequence <> w.version
           or last_entry.balance_after <> w.balance
           or last_entry.entry_hash <> w.ledger_head_hash then
          raise exception 'carteira % tem saldo sem lançamento correspondente (versão %, último lançamento %)',
            target_wallet, w.version, last_entry.sequence;
        end if;
        return null;
      end $$;
    `);

    this.addSql('alter table wallets drop column if exists ledger_sequence;');
  }
}
