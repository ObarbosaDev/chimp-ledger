import { Migration } from '@mikro-orm/migrations';

/**
 * Esquema inicial. A ideia que guiou tudo aqui: o banco não confia na
 * aplicação. Unicidade, saldo não negativo, ledger imutável, conta que fecha
 * e "não existe saldo sem lançamento" são verificados pelo Postgres, então
 * nem um bug nosso nem um SQL manual conseguem quebrar essas regras sem que
 * o commit falhe.
 */
export class Migration20261120120000_esquema_inicial extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- papéis
    this.addSql(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'chimp_app') then
          create role chimp_app nologin;
        end if;
      end $$;
    `);

    // ------------------------------------------------------------ provedores
    this.addSql(`
      create table providers (
        id          text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
        active      boolean not null default true,
        currencies  char(3)[] not null default '{}',
        created_at  timestamptz not null default now()
      );
    `);
    // "internal" é o provedor das transações que o próprio sistema gera (OPENING).
    this.addSql(`insert into providers (id, currencies) values ('internal', '{}');`);

    // -------------------------------------------------------------- carteiras
    this.addSql(`
      create table wallets (
        id                uuid primary key,
        player_id         uuid not null,
        currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance           numeric(19, 2) not null check (balance >= 0),
        version           integer not null check (version >= 1),
        ledger_head_hash  char(64) not null,
        created_at        timestamptz not null,
        updated_at        timestamptz not null,
        unique (player_id, currency)
      );
    `);

    // -------------------------------------------------- transações de aposta
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null references providers (id),
        external_transaction_id            text not null check (length(external_transaction_id) between 1 and 128),
        idempotency_key                    text not null check (length(idempotency_key) between 1 and 256),
        payload_hash                       text not null,
        wallet_id                          uuid not null references wallets (id),
        player_id                          uuid not null,
        round_id                           text not null check (length(round_id) between 1 and 128),
        game_id                            text not null check (length(game_id) between 1 and 128),
        kind                               text not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(19, 2) not null check (amount >= 0),
        currency                           char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id           uuid references wager_transactions (id),
        status                             text not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        result_balance                     numeric(19, 2) check (result_balance >= 0),
        processed_at                       timestamptz,
        reference_attempts                 integer not null default 0 check (reference_attempts >= 0),
        next_reference_check_at            timestamptz,
        created_at                         timestamptz not null,

        unique (provider_id, external_transaction_id),
        unique (provider_id, idempotency_key),

        constraint wager_transactions_amount_positive_check
          check (kind = 'LOSS' or amount > 0),
        constraint wager_transactions_reversal_reference_check
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_bet_without_reference_check
          check (kind <> 'BET' or reference_external_transaction_id is null),
        constraint wager_transactions_opening_internal_check
          check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint wager_transactions_failure_code_check
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_final_state_check
          check (status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null),
        constraint wager_transactions_result_snapshot_check
          check ((status in ('PROCESSED', 'REJECTED')) = (result_balance is not null))
      );
    `);

    // Uma referência só pode ser revertida uma vez, por qualquer tipo de
    // reversão. Se REFUND e ROLLBACK da mesma BET passassem, o jogador
    // receberia o valor duas vezes.
    this.addSql(`
      create unique index uq_wager_transactions_reversal_once
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create index ix_wager_transactions_pending_reference
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);

    // ------------------------------------------------------------------ ledger
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null references wallets (id),
        transaction_id  uuid not null references wager_transactions (id),
        sequence        integer not null check (sequence >= 1),
        direction       text not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(19, 2) not null check (amount > 0),
        currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_before  numeric(19, 2) not null check (balance_before >= 0),
        balance_after   numeric(19, 2) not null check (balance_after >= 0),
        prev_hash       char(64) not null,
        entry_hash      char(64) not null,
        created_at      timestamptz not null,

        unique (wallet_id, sequence),
        unique (wallet_id, transaction_id),

        constraint wallet_ledger_entries_arithmetic_check check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);

    // -------------------------------------------------------- inbox / outbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   text not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     text not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        lease_until      timestamptz,
        published_at     timestamptz,
        created_at       timestamptz not null default now()
      );
    `);
    this.addSql(`
      create index ix_outbox_messages_due
        on outbox_messages (coalesce(next_attempt_at, occurred_at))
        where published_at is null;
    `);

    // ------------------------------------------------------------- triggers
    this.addSql(`
      create function forbid_ledger_change() returns trigger language plpgsql as $$
      begin
        raise exception 'ledger é imutável: % bloqueado em wallet_ledger_entries', tg_op
          using errcode = 'P0001';
      end $$;
    `);
    this.addSql(`
      create trigger trg_ledger_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_change();
    `);
    this.addSql(`
      create trigger trg_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_change();
    `);

    // Cada lançamento tem que continuar exatamente de onde o anterior parou:
    // sequência seguinte, saldo inicial igual ao saldo final do anterior e
    // prev_hash igual ao hash do anterior. O primeiro elo usa o gênese.
    this.addSql(`
      create function check_ledger_chain() returns trigger language plpgsql as $$
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
      create trigger trg_ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function check_ledger_chain();
    `);

    // Identidade da carteira não muda, e a versão anda junto com o saldo:
    // +1 quando o saldo muda, igual quando não muda.
    this.addSql(`
      create function check_wallet_update() returns trigger language plpgsql as $$
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
      create trigger trg_wallet_update
        before update on wallets
        for each row execute function check_wallet_update();
    `);

    // A regra mais importante: saldo materializado e ledger andam juntos.
    // Roda no commit (deferred), porque dentro da transação a carteira e o
    // lançamento são gravados em comandos separados.
    this.addSql(`
      create function check_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        w wallets%rowtype;
        last_entry wallet_ledger_entries%rowtype;
      begin
        -- A mesma checagem dispara pelas duas tabelas; muda só de onde vem o id.
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
    this.addSql(`
      create constraint trigger trg_wallet_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger();
    `);
    this.addSql(`
      create constraint trigger trg_ledger_matches_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger();
    `);

    // Estado final é final. E os campos de negócio nunca mudam depois de
    // gravados; só o ciclo de vida anda.
    this.addSql(`
      create function check_wager_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transação % já está em estado final (%)', old.id, old.status;
        end if;
        if (new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount,
            new.currency, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount,
            old.currency, old.reference_external_transaction_id, old.created_at) then
          raise exception 'campos de negócio da transação % não podem mudar', old.id;
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger trg_wager_transaction_update
        before update on wager_transactions
        for each row execute function check_wager_transaction_update();
    `);
    this.addSql(`
      create trigger trg_wager_transaction_no_delete
        before delete on wager_transactions
        for each row execute function forbid_ledger_change();
    `);

    // ---------------------------------------------------------------- grants
    this.addSql('grant usage on schema public to chimp_app;');
    this.addSql('grant select on providers to chimp_app;');
    this.addSql('grant select, insert, update on wallets to chimp_app;');
    this.addSql('grant select, insert, update on wager_transactions to chimp_app;');
    this.addSql('grant select, insert on wallet_ledger_entries to chimp_app;');
    this.addSql('grant select, insert, update on inbox_messages to chimp_app;');
    this.addSql('grant select, insert, update on outbox_messages to chimp_app;');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop table if exists providers;');
    this.addSql('drop function if exists check_wager_transaction_update();');
    this.addSql('drop function if exists check_wallet_matches_ledger();');
    this.addSql('drop function if exists check_wallet_update();');
    this.addSql('drop function if exists check_ledger_chain();');
    this.addSql('drop function if exists forbid_ledger_change();');
    // O papel chimp_app fica: ele é do cluster, não deste esquema, e pode
    // estar sendo usado por outra base.
  }
}
