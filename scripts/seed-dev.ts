import pg from 'pg';

// Dados mínimos para usar a API no ambiente local: os mesmos provedores que
// existem como clients no realm do Keycloak. Fica fora das migrações de
// propósito: migração é esquema, e provedor cadastrado é dado de ambiente.
// Pode rodar várias vezes; o que já existe é mantido.
const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error('Defina MIGRATOR_DATABASE_URL (veja o .env.example).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(
    `insert into providers (id, currencies)
     values ('provider-a', '{BRL,USD}'), ('provider-b', '{BRL}')
     on conflict (id) do nothing`,
  );
  console.info('Provedores de desenvolvimento prontos: provider-a, provider-b.');
} finally {
  await client.end();
}
