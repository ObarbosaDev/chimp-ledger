# Arquitetura

Aqui eu explico por que o chimp-ledger ficou do jeito que ficou: o que decidi, o que descartei, como interpretei os pontos em aberto do enunciado e o que sei que não está resolvido. Como rodar e testar está no [README](README.md). As decisões maiores têm um registro curto em [`docs/adr/`](docs/adr), e a ligação de cada exigência com o código e o teste está em [`docs/RASTREABILIDADE.md`](docs/RASTREABILIDADE.md).

## Ponto de partida

O enunciado deixa claro que o que importa é dinheiro certo sob duplicação, desordem, concorrência e queda de processo. Então a primeira decisão foi não deixar nenhuma garantia financeira importante depender só do código da aplicação.

Saldo não negativo, saldo igual ao ledger, ledger imutável, idempotência, reversão única e estado final imutável são protegidos no domínio e também no banco, com constraint ou trigger. Se o código tiver um bug, o banco recusa a escrita.

Duas regras ficaram só na aplicação, porque dependem de contexto que o banco não tem:

- a aposta liquidada (com WIN ou LOSS) não aceita outra liquidação nem reembolso;
- o provedor da operação tem que ser o do token.

Essas duas eu cobri com teste e com sabotagem no `bun run test:mutation`, que remove a regra e confere que algum teste quebra.

## Estrutura

É um monólito modular. A mesma imagem roda em dois papéis:

- a **api** atende HTTP;
- o **worker** consome a fila, publica a outbox e reprocessa referências pendentes.

Os dois podem ter várias réplicas.

Cada módulo (`wallet`, `wagering`, `messaging`, `auth`, `health`, `shared`) tem `domain`, `application` e `infrastructure`. O domínio não importa Nest, MikroORM nem Bun, e um teste de arquitetura quebra se isso mudar.

Não separei em serviços porque o coração do problema é uma transação SQL só: saldo, ledger, transação, inbox e outbox são confirmados juntos. Dividir isso traria transação distribuída sem necessidade.

HTTP e fila chamam o mesmo caso de uso, `SubmitWagerTransaction`, e o reprocessamento usa a mesma parte que decide e aplica (`WagerProcessor`). Nenhum outro código escreve em `wallets` ou no ledger, então as regras não têm como divergir entre um caminho e outro.

## O caminho de uma transação

Tudo numa transação SQL:

1. se veio da fila, gravo a mensagem na inbox (`ON CONFLICT DO NOTHING`); se ela já estava lá, devolvo o resultado original;
2. travo a carteira com `SELECT ... FOR UPDATE`;
3. confiro se o provedor está ativo e pode operar na moeda. Se não puder, mas a chave já existir, ainda devolvo o replay: o reenvio de uma operação antiga não deve virar erro só porque o provedor foi desativado depois;
4. reservo a chave de idempotência (`ON CONFLICT DO NOTHING`). Se ela já existe, o mesmo `payloadHash` é replay, e um hash diferente é conflito;
5. aplico as regras (dono da carteira, moeda, referência, ciclo de vida da referência, saldo), mudo saldo e ledger, gravo o status e enfileiro os eventos na outbox;
6. no commit, os triggers diferidos `trg_wallet_matches_ledger` e `trg_ledger_matches_wallet` conferem que saldo e ledger andaram juntos.

O que dá para validar sem banco (formato, `Money`, tipo de operação) eu valido antes de abrir a transação, para pedido malformado nem pegar lock.

## Persistência

Usei MikroORM, como o enunciado prefere, pelo que ele deixa explícito: `transactional()`, `LockMode` e migrações reversíveis. Para manter o domínio com construtor privado e sem decorators, o mapeamento fica em `EntitySchema` na infraestrutura, e mappers montam as entidades com `rehydrate`.

Nas escritas de dinheiro eu não uso o flush automático. Os repositórios fazem `insert` e `nativeUpdate` em ordem, porque existe FK entre carteira, transação e lançamento, e um trigger que confere tudo no commit. Prefiro saber exatamente que SQL roda e em que ordem.

As migrações são classes do MikroORM com SQL escrito à mão, porque o gerador não sabe criar trigger, constraint diferida, índice parcial nem `GRANT`. Todas têm `down`, e um teste desce e sobe tudo de novo. Mais em [ADR 002](docs/adr/002-mikroorm-com-entityschema.md).

## Dinheiro

`Money` usa `decimal.js`, é imutável e só aceita string com duas casas. Ele recusa `NaN`, `Infinity`, notação científica, vazio, sinal, vírgula, mais de duas casas e `number`.

Ele também nunca arredonda. Se chegar `1.005`, a resposta é erro de contrato: arredondar seria decidir o centavo no lugar do provedor.

No banco, o valor fica em `NUMERIC(19,2)` e a moeda em `CHAR(3)`, e a conversão passa sempre por string. Nos eventos, o dinheiro vai como `{ amount, currency }`.

O modelo é multi-moeda (a carteira tem moeda, e o provedor tem a lista das que pode usar), e há testes de conflito de moeda. No ambiente de desenvolvimento só uso BRL.

## Concorrência

Fui de lock pessimista por carteira. A disputa só existe dentro da mesma carteira, então o lock na linha dela serializa o que precisa ser serializado e deixa o resto em paralelo, sem lock global.

Considerei duas alternativas:

- **lock otimista com retry**, que numa carteira quente vira uma fila de tentativas perdidas;
- **`UPDATE ... WHERE balance >= x`**, que resolve a BET numa linha só. Mas as reversões precisam ler a referência e gravar um ledger encadeado, e isso volta a ser ler e depois escrever.

Cada transação roda com `lock_timeout` de 2 s. Se a carteira estiver travada demais, a operação desiste com erro transitório (`503` com `Retry-After`, ou nova entrega na fila) e conta em `lock_conflicts_total`.

O lock não é a única proteção:

- o `UPDATE` da carteira leva a versão no `WHERE`;
- o ledger tem `UNIQUE (wallet_id, sequence)`;
- existe o `CHECK (balance >= 0)`.

Testei tirando o `FOR UPDATE`: os testes de concorrência falham, mas por erro de escrita, não por saldo errado. Mais em [ADR 001](docs/adr/001-lock-pessimista-por-carteira.md).

## O esquema

| Garantia | No banco |
|---|---|
| Uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Versão sobe de um em um, só quando o saldo muda | `trg_wallet_update` |
| Saldo e ledger andam juntos | `trg_wallet_matches_ledger` e `trg_ledger_matches_wallet`, diferidos |
| Ledger imutável | `trg_ledger_immutable`, `trg_ledger_no_truncate` e o papel da aplicação sem `UPDATE`/`DELETE` |
| Conta do lançamento fecha | `CHECK` de `balance_before ± amount = balance_after` |
| Ledger encadeado e sem buraco | `trg_ledger_chain` |
| Um lançamento por transação e carteira | `UNIQUE (wallet_id, transaction_id)` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reverter só uma vez | índice único parcial sobre a referência das reversões processadas |
| Estado final não muda | `trg_wager_transaction_update` |
| Inbox | PK `(consumer_name, message_id)` |

A aplicação usa o papel `chimp_app`, que não pode alterar o ledger. As migrações usam o `chimp_migrator`. As funções de trigger têm `search_path` fixo, para uma tabela temporária com o mesmo nome não enganar a checagem.

Cada lançamento guarda o hash do anterior. Trigger e permissão já impedem a aplicação de mexer no ledger; a cadeia serve para quando quem mexe é alguém com acesso de dono ao banco. A reconciliação recalcula a cadeia e aponta o primeiro lançamento quebrado. Mais em [ADR 003](docs/adr/003-ledger-encadeado-por-hash.md).

## Estados da transação

```
PENDING ──► PROCESSED | REJECTED | FAILED
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

Os estados finais não mudam mais. O domínio lança `InvalidTransactionStateError` e o trigger recusa no banco.

Nenhum fluxo grava `FAILED` hoje. As falhas de infraestrutura que eu conheço ou são passageiras (banco fora, `lock_timeout`), e aí a transação é desfeita e tentada de novo, ou acontecem antes de existir uma transação para marcar (payload inválido, carteira inexistente), e aí a mensagem vai para a DLQ. Gravar `FAILED` pediria uma segunda escrita justo quando o banco está com problema. Preferi deixar a operação na fila ou na DLQ, onde ela ainda pode ser reprocessada. A transição está no domínio e testada, caso apareça um caso que precise dela.

## Interpretações

Onde o enunciado deixa espaço, decidi assim:

- **Reversão única por qualquer tipo.** O enunciado fala em "pelo mesmo tipo de operação". Fui mais rígido: depois de um REFUND, o ROLLBACK da mesma BET também é recusado (`ALREADY_REVERSED`). Senão o jogador receberia o valor da aposta duas vezes.
- **Aposta liquidada fica fechada.** Com um WIN ou LOSS válido, outra liquidação, REFUND ou ROLLBACK da BET é recusado (`BET_ALREADY_SETTLED`). Se o WIN for desfeito por ROLLBACK, a BET volta a ficar em aberto.
- **WIN e LOSS podem referenciar a BET ou não.** Quando referenciam, valem todas as regras de referência.
- **Carteira de outro jogador.** A recusa é `WALLET_PLAYER_MISMATCH`, e o saldo dessa carteira não aparece na resposta, no evento nem no banco.
- **Reversão que deixaria saldo negativo** é `NEGATIVE_BALANCE_PREVENTED`, diferente de `INSUFFICIENT_FUNDS`. Uma é rotina, a outra pede alguém olhando.
- **Replay devolve o saldo daquele momento**, que fica guardado na transação quando ela termina.

Referência que ainda não chegou deixa a transação em `PENDING_REFERENCE` (`202`). O worker tenta de novo com espera que começa em 2 s, dobra e para em 5 min, até 10 tentativas ou 1 hora. Mensagem fora de ordem costuma chegar em segundos, e se em uma hora a referência não apareceu, ela provavelmente não existe.

Esgotado o prazo, a transação é rejeitada e o evento é publicado. O código diz se a referência nunca chegou (`REFERENCE_NOT_FOUND`) ou se chegou e não terminou (`REFERENCE_NOT_PROCESSED`).

## Erros e status HTTP

Cada `failureCode` tem uma ação para o provedor: desistir, corrigir o payload ou tentar de novo (`src/wagering/domain/failure-code.ts`, tabela no README). O status HTTP segue a mesma lógica:

- `409` é conflito, então não adianta reenviar igual;
- `422` é decisão de negócio final;
- `503` é problema nosso e passageiro, com `Retry-After`;
- `202` é aceito e pendente;
- `400` é payload inválido.

Uma rejeição de negócio responde `422` com o resultado da transação no corpo (`status: "REJECTED"` e `failureCode`), porque ela foi gravada e pode ser consultada depois. Os demais erros usam o corpo `{ code, message, retryable }`.

A exceção é `PROVIDER_NOT_ALLOWED` numa operação nova: ele é recusado antes de reservar a chave, então não grava transação. Erro que eu não previ vira `500 INTERNAL_ERROR`. Mais em [ADR 005](docs/adr/005-mapa-de-status-http.md).

O `payloadHash` é o SHA-256 do JSON com as chaves ordenadas, montado com os campos de negócio:

- `providerId`, `externalTransactionId`, `playerId`, `walletId`;
- `roundId`, `gameId`, `kind`, `money`;
- `referenceExternalTransactionId`.

Header e metadados de transporte não entram. Repetir o mesmo `externalTransactionId` com outra chave também é conflito: o provedor está reaproveitando um identificador.

## Fila

O consumidor faz ack só depois do commit. Se o processo morrer entre um e outro, a mensagem volta e a inbox transforma a reentrega em replay.

Cada erro é classificado em um de três tipos:

- **negócio**: já ficou gravado, então confirmo;
- **permanente** (payload inválido, carteira ou provedor inexistente): vai direto para a DLQ com o motivo;
- **transitório**: a mensagem volta com espera crescente e, depois de 5 entregas, o redrive manda para a DLQ.

Erro que eu não previ conta como transitório. Se for bug, acaba na DLQ, o que é melhor que confirmar e perder a operação.

O `MessageGroupId` é a carteira. Se a primeira mensagem de um grupo falha, devolvo as seguintes sem processar, para não passarem na frente. Mas a FIFO é só otimização: o teste de inbox reentrega a mesma mensagem com a deduplicação do SQS desligada.

No `SIGTERM`, paro de pedir mensagens, termino as que comecei e devolvo na hora as que recebi e não comecei. Descobri testando que abortar o long polling no cliente não cancela o receive no servidor. As mensagens que chegassem ficariam invisíveis por um visibility timeout inteiro. Por isso o desligamento espera o receive voltar (até `SQS_WAIT_TIME_SECONDS`).

## Outbox

Os eventos entram na outbox na mesma transação do saldo. Um relay no worker reivindica carteiras, não eventos: trava com `SKIP LOCKED` o evento mais antigo pendente de cada carteira e reserva todos os pendentes dela por um lease de 30 s. Depois, fora da transação, publica em lotes de até 10, na ordem.

Se o processo morrer, o lease vence e outra instância continua a carteira de onde parou. Um evento pode sair duas vezes: o `eventId` é estável e serve de `MessageDeduplicationId`, e o consumidor deduplica por ele.

O lote veio do teste de carga. Publicando um evento por chamada, o lag chegou a 54 s, e mais paralelismo quase não ajudou. Medindo, o LocalStack aceitava cerca de 480 mensagens/s uma a uma e mais de 3.000/s em lotes de 10. Com lote e um índice parcial para a reivindicação, o lag máximo caiu para 4,7 s ([`docs/LOAD_TEST.md`](docs/LOAD_TEST.md)).

O preço é um caso raro: o SQS recusar um evento do meio do lote e aceitar os seguintes. Esses ficam na fila fora de ordem, o caso conta em `outbox_order_anomalies_total` e o `walletVersion` do evento permite reordenar. Mais em [ADR 004](docs/adr/004-outbox-com-lease.md).

## Autenticação

Usei Keycloak, sem nada de autenticação feita à mão. A aplicação conhece só a porta `IdentityProvider`; o adaptador valida o JWT pela JWKS com `jose` (só RS256, emissor e audiência conferidos).

O guard é global e fechado por padrão. Cada rota declara o escopo que exige, e o `provider_id` vem do token: corpo com outro provedor recebe `403`. Transação de outro provedor responde `404`, para não confirmar que existe. Keycloak fora do ar responde `503`, porque o problema é nosso.

Como pede o enunciado, `/health/*` é aberto, e a fila é tratada como canal interno. Mesmo assim, o provedor da mensagem passa pelas validações de domínio. Com `AUTH_ENABLED=true` e sem emissor configurado, o processo nem sobe.

## Observabilidade

- **Logs** em JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem valores nem payload.
- **Métricas** Prometheus na API e no worker. O lag da outbox é medido na hora da coleta e, se o banco cair, sai como `NaN` sem derrubar as outras.
- **Health**: `/health/live` não depende de nada, e `/health/ready` confere Postgres e SQS.
- **Dashboard**: o Compose completo sobe um Grafana com um dashboard versionado.

## Testes

Integração e concorrência rodam contra Postgres, LocalStack e Keycloak reais (Testcontainers). Os testes de concorrência sobem processos de verdade:

- o cenário 2 × 80 sobre 100;
- a mesma aposta 50 vezes;
- uma simulação com seed reproduzível em 3 instâncias, comparada com um oráculo simples;
- recuperação com processo derrubado depois do commit, com eventos reservados e com `kill -9` no meio da carga.

Os testes que movem dinheiro terminam conferindo, no Postgres, que o saldo de cada carteira bate com o ledger.

## Limitações

- **Carteira quente tem teto.** No teste de carga, uma carteira só ficou em ~92 req/s com p99 perto de 1 s. Para um jogador está bem; para uma carteira compartilhada, não. Resolver isso pede particionar o saldo, o que muda o modelo.
- **O lote da outbox pode inverter a ordem** no caso raro de falha no meio dele. Fica medido, mas o consumidor precisa usar o `walletVersion`.
- **Outbox e inbox nunca são limpas.** Em produção precisaria de expurgo com retenção. A inbox só precisa guardar a mensagem enquanto a fila ainda pode reentregá-la.
- **O ledger cresce sem limite**, e a reconciliação lê tudo da carteira. A evolução seriam checkpoints de saldo já conferidos.
- **A readiness da API depende do SQS** porque o enunciado pede. A API em si não usa a fila, então uma queda do SQS tira réplicas do balanceador sem necessidade.
- **Banco travado sem fechar a conexão** pode prender uma conexão do pool na checagem de readiness até o timeout.
- **Os números de carga são do LocalStack**, numa máquina só. Servem para achar gargalo e comparar antes e depois, não para prometer vazão na AWS.
- **O teste de `SIGTERM` com processo real só roda no Linux** (CI).
- **Ficou de fora:** rate limiting por provedor, mTLS, rotação de segredos e criptografia em repouso. Os segredos do Compose e do realm são de desenvolvimento local.
