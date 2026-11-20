-- Usuário que a aplicação usa em runtime. Ele não é dono de nenhuma tabela:
-- quem cria e altera estrutura é o chimp_migrator. A migração cria o papel
-- se ele não existir e só concede o mínimo (sem UPDATE/DELETE no ledger).
--
-- Senha fixa porque isto roda só no ambiente local (docker compose e testes).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chimp_app') THEN
    CREATE ROLE chimp_app LOGIN PASSWORD 'chimp_app';
  ELSE
    ALTER ROLE chimp_app LOGIN PASSWORD 'chimp_app';
  END IF;
END
$$;
