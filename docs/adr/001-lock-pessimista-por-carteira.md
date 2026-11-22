# ADR 001: Lock pessimista por carteira

**Status:** aceita

## Contexto

Várias instâncias da API e do worker podem processar operações da mesma carteira ao mesmo tempo. O caso clássico é o do enunciado: saldo de 100,00 e duas apostas de 80,00 simultâneas. Exatamente uma pode passar.

A disputa só existe dentro da mesma carteira. Carteiras diferentes não têm nada a ver uma com a outra e precisam andar em paralelo.

## Decisão

Dentro da transação SQL, travo a linha da carteira com `SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE` no MikroORM) antes de ler saldo, resolver referência ou escrever qualquer coisa. Cada transação roda com `SET LOCAL lock_timeout = '2s'`: se não conseguir o lock nesse tempo, desiste com erro transitório.

## Alternativas consideradas

**Lock otimista com `version` e retry.** Não segura lock enquanto processa, mas numa carteira quente a maioria das tentativas falha e precisa recomeçar do zero, incluindo ler a referência de novo. Também exige lógica de retry em todos os chamadores (HTTP, fila e reprocessamento).

**`UPDATE` atômico condicionado** (`SET balance = balance - x WHERE balance >= x`). Resolve a BET sozinho, mas as reversões precisam ler a referência, conferir se ela já foi revertida ou liquidada, e gravar um lançamento com saldo de antes e de depois encadeado no anterior. Isso volta a ser ler e depois escrever, e o lock volta a ser necessário.

## Consequências

- Operações da mesma carteira viram uma fila ordenada no banco, sem retry na aplicação.
- Carteiras diferentes não se bloqueiam. Não existe lock global.
- O `lock_timeout` impede que uma carteira muito disputada prenda todas as conexões do pool: o excedente vira `503` com `Retry-After` (ou nova entrega na fila) e aparece em `lock_conflicts_total`.
- Uma carteira tem um teto de vazão. No teste de carga, ~92 req/s numa carteira só, com p99 perto de 1 s.
- O lock não é a única barreira. A versão no `WHERE` do `UPDATE`, o `UNIQUE (wallet_id, sequence)` do ledger e o `CHECK (balance >= 0)` continuam valendo. A sabotagem 1 do `test:mutation` remove o lock e mostra que o resultado é erro, não saldo errado.
