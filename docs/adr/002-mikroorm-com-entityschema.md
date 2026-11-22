# ADR 002: MikroORM com `EntitySchema` e domínio puro

**Status:** aceita

## Contexto

O enunciado pede MikroORM (preferencial) ou TypeORM, e um domínio com construtor privado, factories (`create`, `from`, `rehydrate`) e sem tipos ou decorators de ORM. O `Money` também não pode depender de tipo monetário do ORM.

## Decisão

- **MikroORM**, pelo que ele deixa explícito: `EntityManager.transactional()`, `LockMode` e migrações com `up` e `down`.
- **Domínio sem nenhuma referência ao ORM.** O mapeamento fica em `EntitySchema`, na camada de infraestrutura, e mappers convertem linha em entidade via `rehydrate`. Um teste de arquitetura falha se o domínio importar ORM, Nest ou Bun.
- **Escrita explícita** nos repositórios (`insert` e `nativeUpdate` em ordem) em vez de depender do flush automático do Unit of Work.
- **Migrações em TypeScript com SQL escrito à mão**, todas reversíveis.

## Alternativas consideradas

**Decorators nas entidades de domínio.** É o uso mais comum do MikroORM, mas coloca o ORM dentro do domínio e briga com o construtor privado.

**Flush automático do Unit of Work.** O ORM decide a ordem dos comandos. Com FK entre carteira, transação e lançamento, e um trigger diferido que confere saldo contra ledger no commit, eu prefiro saber exatamente qual SQL roda e em que ordem. O erro de constraint aparece onde aconteceu.

**Migrações geradas a partir das entidades.** O gerador não expressa triggers, constraints diferidas, índices parciais, `CHECK` com aritmética nem `GRANT` por papel, que são justamente as garantias que o enunciado pede no banco.

## Consequências

- O domínio é testável sem banco e não muda se o ORM mudar.
- Existe código de mapeamento (schemas e mappers) que um modelo com decorators não teria. É o preço de manter o domínio limpo.
- `Money` vira `NUMERIC(19,2)` e `CHAR(3)` no banco, sempre convertido por string.
- O esquema é lido e revisado como SQL, e um teste desce todas as migrações e sobe de novo sem sobrar nada.
