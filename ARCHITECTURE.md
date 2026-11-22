# Arquitetura

Este documento explica por que o chimp-ledger é do jeito que é: as decisões, o que considerei no lugar delas, as interpretações que adotei onde o enunciado deixa espaço e o que ficou de fora. O README mostra como rodar; aqui fica o raciocínio.

As decisões maiores têm um registro próprio em [`docs/adr/`](docs/adr). A ligação de cada exigência com o código e o teste que a prova está em [`docs/RASTREABILIDADE.md`](docs/RASTREABILIDADE.md).

---

## 1. O princípio que guiou o resto

Dinheiro não pode depender de uma camada só. Toda invariante financeira importante está protegida em dois lugares: no domínio, que recusa a operação inválida com uma mensagem clara, e no banco, que recusa a escrita inválida mesmo que o código tenha um bug ou alguém rode SQL na mão.

Na prática isso significa que, se eu apagar a proteção do código, o banco segura. E se eu apagar a proteção do banco, um teste percebe. O `bun run test:mutation` faz exatamente esse exercício: remove uma garantia por vez e confere que algum teste fica vermelho.

---

## 2. Visão geral

Um monólito modular com dois papéis, a partir da mesma imagem:

- **api**: recebe HTTP. Roda em várias réplicas.
- **worker**: consome a fila de transações, publica a outbox e reprocessa as referências pendentes. Também pode rodar em várias réplicas.

Os módulos são `wallet`, `wagering`, `messaging`, `auth`, `health` e `shared`. Cada um separa `domain`, `application` e `infrastructure`. O domínio não importa NestJS, MikroORM nem Bun, e um teste de arquitetura (`test/architecture/dependency-rule.test.ts`) falha se alguém quebrar essa regra.

Escolhi monólito modular em vez de serviços separados porque o problema inteiro gira em torno de uma transação SQL. Saldo, ledger, transação, inbox e outbox precisam ser confirmados juntos. Separar isso em serviços traria transação distribuída para um lugar onde ela não precisa existir.

### Uma porta só para o dinheiro

HTTP e fila chamam o mesmo caso de uso, `SubmitWagerTransaction`. O reprocessamento de pendências chama o `WagerProcessor`, que é a parte desse caso de uso que decide e aplica. Nenhum outro código escreve em `wallets` ou em `wallet_ledger_entries`. Assim, as regras de negócio não têm como divergir entre um canal e outro.

### O fluxo de uma transação

Tudo dentro de uma transação SQL, nesta ordem:

1. **Inbox** (só quando veio da fila): `INSERT ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`. Se a mensagem já tinha sido vista, devolvo o resultado original e não faço mais nada.
2. **Lock da carteira**: `SELECT ... FOR UPDATE` na linha da carteira. A partir daqui, ninguém mais mexe nessa carteira até o commit.
3. **Reserva da idempotência**: `INSERT ... ON CONFLICT DO NOTHING` na transação, com unicidade em `(provider_id, idempotency_key)` e em `(provider_id, external_transaction_id)`. Se a chave já existe, comparo o `payloadHash`: igual é replay, diferente é conflito.
4. **Regras**: dono da carteira, provedor ativo e com a moeda, moeda da carteira, referência, ciclo de vida da referência e saldo.
5. **Efeito**: atualizo o saldo e a versão, gravo o lançamento no ledger, mudo o status da transação e enfileiro os eventos na outbox.
6. **Commit**: um trigger diferido confere, no commit, que o saldo da carteira bate com o ledger.

Validação que não depende do banco (formato do payload, `Money`, tipo de operação) acontece antes de abrir a transação. Pedido malformado nem chega a pegar lock.

---

## 3. Persistência: MikroORM com `EntitySchema`

O enunciado pede construtor privado e factories, e um domínio sem decorators de ORM. Por isso o mapeamento fica fora das classes de domínio, em `EntitySchema`, e mappers convertem a linha do banco em entidade usando `rehydrate`.

Escolhi MikroORM pelo que ele deixa explícito: `EntityManager.transactional()` para delimitar a transação, `LockMode.PESSIMISTIC_WRITE` para o lock e migrações com `up` e `down`.

Uma decisão que vale registrar: **não uso o flush automático do Unit of Work** para as escritas de dinheiro. Os repositórios fazem `insert` e `nativeUpdate` em ordem explícita. Existe FK entre carteira, transação e lançamento, e um trigger diferido que confere tudo no commit. Com a ordem explícita eu sei exatamente qual SQL roda e em que sequência, e o erro de constraint aparece no ponto em que aconteceu.

As **migrações são classes TypeScript do MikroORM com SQL escrito à mão** dentro. O gerador automático não expressa o que o esquema precisa: triggers, constraints diferidas, índices parciais, `CHECK` com aritmética e `GRANT` por papel. Toda migração tem `down`, e um teste desce todas e sobe de novo sem sobrar nada.

Mais detalhes em [ADR 002](docs/adr/002-mikroorm-com-entityschema.md).

---

## 4. Dinheiro

`Money` usa `decimal.js` e é imutável. Na entrada ele só aceita string com exatamente duas casas decimais. `NaN`, `Infinity`, notação científica, string vazia, sinal, zero à esquerda, vírgula, mais de duas casas e `number` são recusados.

**`Money` nunca arredonda.** Se o provedor manda `1.005`, a resposta é erro de contrato, não `1.01`. Arredondar em silêncio seria decidir um centavo no lugar de quem mandou o valor.

No banco, valor e moeda ficam em colunas separadas: `NUMERIC(19,2)` e `CHAR(3)`. Conversões de e para o banco passam sempre por string. Nos eventos, o dinheiro vai como `MoneyProps` (`{ amount, currency }`), nunca como a instância.

O modelo é multi-moeda: a carteira tem moeda, operação com moeda diferente é recusada, e o provedor tem a lista de moedas que pode usar. O ambiente de desenvolvimento usa BRL, e há testes de conflito de moeda.

---

## 5. Concorrência

A unidade de concorrência é a carteira. Usei **lock pessimista por carteira** (`SELECT ... FOR UPDATE`) dentro da transação.

Alternativas que considerei:

- **Lock otimista com retry.** Funciona bem quando conflito é raro. Numa carteira quente, que é justamente o caso que importa, ele vira uma sequência de tentativas que falham e consomem banco à toa, além de exigir código de retry em todos os chamadores.
- **`UPDATE ... SET balance = balance - x WHERE balance >= x`.** É elegante para a BET, mas as reversões precisam ler a referência, conferir o ciclo de vida dela e gravar um ledger encadeado com o saldo de antes e de depois. Isso volta a ser leitura e escrita, e o lock acaba necessário de qualquer forma.

O lock pessimista serializa só a mesma carteira. Carteiras diferentes andam em paralelo, sem lock global.

Para uma carteira muito disputada não prender conexão indefinidamente, cada transação roda com `SET LOCAL lock_timeout = '2s'`. Estourou: vira falha transitória (`503` com `Retry-After` no HTTP, nova entrega na fila) e conta na métrica `lock_conflicts_total`.

O lock dá vazão e ordem. Ele não é a única barreira:

- o `UPDATE` da carteira leva a versão no `WHERE`;
- o ledger tem `UNIQUE (wallet_id, sequence)`, então dois lançamentos sobre o mesmo saldo não entram;
- `CHECK (balance >= 0)` na carteira.

Tirando o `FOR UPDATE` de propósito (é a sabotagem 1), os testes de concorrência quebram, mas o dinheiro continua certo: a escrita concorrente é recusada pelo banco. O pior caso sem o lock é erro, nunca saldo errado.

Mais detalhes em [ADR 001](docs/adr/001-lock-pessimista-por-carteira.md).

---

## 6. Garantias no esquema

| Garantia | Como o banco aplica |
|---|---|
| Uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Versão começa em 1 e sobe de um em um, só quando o saldo muda | trigger `trg_wallet_update` |
| Saldo só muda com lançamento, e vice-versa | trigger **diferido** que confere no commit |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE`; o papel da aplicação nem tem permissão |
| Lançamento com conta certa | `CHECK` de `balance_before ± amount = balance_after` |
| Ledger encadeado | trigger exige que o primeiro lançamento seja a sequência 1 e que sequência, saldo e `prev_hash` continuem do anterior |
| Um lançamento por transação e carteira | `UNIQUE (wallet_id, transaction_id)` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reverter só uma vez | índice único parcial sobre a referência das reversões processadas |
| Estado final não muda | trigger `trg_wager_transaction_update` |
| `OPENING` só interno | `CHECK` amarrando `OPENING` ao provedor interno |
| Recusa por carteira alheia não guarda saldo | `CHECK` proíbe snapshot de saldo nesse caso |
| Mensagem processada uma vez por consumidor | PK `(consumer_name, message_id)` na inbox |

O banco tem dois papéis: `chimp_migrator`, dono das tabelas e usado só nas migrações, e `chimp_app`, usado pela aplicação, sem permissão de `UPDATE` ou `DELETE` no ledger. As funções de trigger têm `search_path` fixo, para que uma tabela temporária com o mesmo nome não engane a checagem (há teste para isso).

### Ledger encadeado por hash

Cada lançamento guarda o hash do anterior: `entry_hash = sha256(prev_hash + ":" + JSON canônico do lançamento)`. O primeiro elo parte de um hash derivado do id da carteira.

O trigger e a falta de permissão já impedem a aplicação de alterar o ledger. A cadeia serve para o caso que eles não cobrem: alguém com acesso de dono ao banco. Se um lançamento for alterado, o hash dele não bate mais, e a reconciliação aponta o primeiro elo quebrado (`chainValid` e `firstBrokenSequence`). Como a escrita já é serializada por carteira, encadear custa quase nada.

O ledger tem uma sequência própria (`ledger_sequence`), separada da versão da carteira. Elas andavam juntas no começo, mas são coisas diferentes: a versão é controle de concorrência, a sequência é a posição no ledger.

Mais detalhes em [ADR 003](docs/adr/003-ledger-encadeado-por-hash.md).

---

## 7. Transações e seus estados

```
PENDING ──► PROCESSED
   │   ──► REJECTED
   │   ──► FAILED
   └─────► PENDING_REFERENCE ──► PROCESSED
                             ──► REJECTED
                             ──► FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são finais. Tentar mudar uma transação final lança `InvalidTransactionStateError` no domínio, e o trigger recusa no banco. Isso é erro de programação, não caminho de negócio. A reidratação (`rehydrate`) reconstrói o estado sem revalidar transições.

### Sobre o `FAILED`

O status e o código `INFRASTRUCTURE_PERMANENT` existem no domínio, mas **nenhum fluxo atual grava `FAILED`**. Isso é uma decisão, não um esquecimento. Olhando cada falha de infraestrutura que o sistema conhece:

- banco fora, conexão caída, `lock_timeout`, deadlock: são passageiras. A transação SQL é desfeita inteira e a operação é tentada de novo (`503` no HTTP, nova entrega na fila);
- payload malformado, carteira inexistente ou provedor desconhecido: a mensagem vai para a DLQ com o motivo. Nesses casos não há transação gravada para marcar como `FAILED`, e no caso da carteira a FK nem deixaria gravar;
- erro inesperado e repetido: depois de 5 entregas, o redrive manda a mensagem para a DLQ.

Gravar `FAILED` exigiria uma segunda transação, depois da que falhou, só para registrar a falha. Se o banco estiver com problema, é justamente essa segunda escrita que tende a falhar também. Preferi deixar a operação na fila ou na DLQ, onde ela continua reprocessável, a marcar como final algo que talvez desse certo na próxima tentativa.

A transição continua no domínio e testada. Se aparecer uma falha permanente que precise ficar na própria transação, o caminho está pronto.

---

## 8. Regras de negócio e interpretações

As regras da seção 7 do enunciado estão em `WagerProcessor` e `evaluateReference`. Onde o enunciado deixa espaço, adotei estas interpretações:

**Uma referência é revertida uma vez só, por qualquer tipo de reversão.** O enunciado diz "pelo mesmo tipo de operação". Fui mais rígido: se uma BET recebeu REFUND, um ROLLBACK da mesma BET também é recusado (`ALREADY_REVERSED`). Senão, REFUND seguido de ROLLBACK devolveria o valor da aposta duas vezes. O índice único parcial no banco aplica a mesma regra.

**Uma BET liquidada não aceita outra liquidação nem reembolso.** Se a BET já tem um WIN ou um LOSS válido, um novo WIN ou LOSS, um REFUND ou um ROLLBACK dela é recusado com `BET_ALREADY_SETTLED`. Se o WIN for desfeito por ROLLBACK, a BET volta a ficar em aberto. E uma BET revertida não pode ser liquidada (`ALREADY_REVERSED`).

**WIN e LOSS podem ou não referenciar a BET.** O enunciado diz que o WIN "pode referenciar". Quando referencia, todas as regras de referência valem.

**A carteira precisa ser do jogador informado.** Senão a recusa é `WALLET_PLAYER_MISMATCH`, e nem a resposta nem o evento mostram o saldo dessa carteira. Um `CHECK` no banco garante que esse saldo não fica gravado.

**Reversão que deixaria o saldo negativo** (por exemplo, ROLLBACK de um WIN que o jogador já apostou de novo) é recusada com `NEGATIVE_BALANCE_PREVENTED`, diferente de `INSUFFICIENT_FUNDS`. Aposta sem saldo é rotina; reversão impossível pede análise.

**Replay devolve o saldo daquele momento.** A transação guarda o saldo resultante quando fica final, e o replay devolve esse valor, não o saldo atual.

**Provedor desativado durante a espera.** Uma transação pendente pode esperar até uma hora. Se o provedor for desativado nesse meio-tempo, o reprocessamento recusa com `PROVIDER_NOT_ALLOWED` e não mexe no saldo.

### Referências fora de ordem

REFUND ou ROLLBACK que chega antes da referência fica `PENDING_REFERENCE` (`202` no HTTP). Um loop do worker reprocessa as pendentes com backoff exponencial: começa em 2 s, dobra a cada tentativa e para em 5 min. O limite é de 10 tentativas ou 1 hora, o que vier primeiro.

Mensagem fora de ordem costuma chegar em segundos. Se em uma hora a referência não apareceu, o mais provável é que ela não exista, e deixar a transação pendurada para sempre esconderia o problema do provedor.

Esgotado o prazo, a transação vira `REJECTED`, com o evento correspondente publicado, e o código diz o que aconteceu:

- `REFERENCE_NOT_FOUND`: a referência nunca chegou;
- `REFERENCE_NOT_PROCESSED`: ela chegou, mas foi rejeitada ou nunca terminou.

São ações diferentes para o provedor, então os códigos também são diferentes.

Vários workers podem reprocessar ao mesmo tempo: o lock da carteira garante que a mesma pendência é aplicada uma vez só (há teste com dois workers).

---

## 9. Códigos de falha

Cada código tem uma ação recomendada, em `src/wagering/domain/failure-code.ts`, para o provedor decidir **sem ler a mensagem**:

| Ação | Significado | Códigos |
|---|---|---|
| `GIVE_UP` | decisão final, não adianta insistir | `INSUFFICIENT_FUNDS`, `NEGATIVE_BALANCE_PREVENTED`, `ALREADY_REVERSED`, `BET_ALREADY_SETTLED`, `REFERENCE_NOT_PROCESSED`, `PROVIDER_NOT_ALLOWED`, `INFRASTRUCTURE_PERMANENT` |
| `FIX_PAYLOAD` | o pedido está errado, reenviar igual falha de novo | `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH` |
| `RETRY` | problema nosso e passageiro | não é um `failureCode`: é a resposta `503` com `retryable: true` |

Os códigos são estáveis: mudar o significado de um é quebra de contrato.

---

## 10. API HTTP

### Status

O mesmo mapa em todos os endpoints:

| Status | Quando |
|---|---|
| `200` | consulta, ou replay idempotente |
| `201` | criado ou processado pela primeira vez |
| `202` | aceito, aguardando a referência |
| `400` | payload inválido (`INVALID_PAYLOAD`) |
| `401` / `403` | sem token válido / sem escopo ou agindo por outro provedor |
| `404` | recurso não existe (ou é de outro provedor) |
| `409` | conflito de idempotência, ou carteira duplicada |
| `422` | regra de negócio recusou, com `failureCode` |
| `503` | falha passageira nossa, com `Retry-After` |

O ponto principal é que `409`, `422` e `503` não se misturam. Com `409`, o provedor sabe que não deve reenviar igual. Com `422`, sabe que a decisão é final. Com `503`, sabe que pode tentar de novo. Erros sempre no formato `{ code, message, retryable }`.

Uma rejeição de negócio é `422`, mas a transação **fica gravada como `REJECTED`** e é auditável. O replay de uma transação rejeitada devolve a mesma rejeição.

Mais detalhes em [ADR 005](docs/adr/005-mapa-de-status-http.md).

### Idempotência e `payloadHash`

O header `Idempotency-Key` é obrigatório e é a fonte da verdade. O `payloadHash` é o SHA-256, em hex, do JSON canônico destes campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`.

JSON canônico quer dizer chaves ordenadas recursivamente, sem espaços, e campos ausentes fora. O header e os metadados de transporte não entram no hash.

- mesma chave e mesmo hash: replay, `idempotentReplay: true`;
- mesma chave e hash diferente: `409 IDEMPOTENCY_CONFLICT`;
- mesmo `externalTransactionId` com outra chave: também `409`. O provedor está reaproveitando um identificador, e isso não pode virar efeito silencioso.

As chaves são escopadas por provedor: dois provedores podem usar a mesma chave sem colidir.

### Ledger e reconciliação

`GET /wallets/:id/ledger` pagina por cursor. O cursor é a sequência do último lançamento lido, codificada em base64url com versão (`{ v: 1, after }`). Ele é opaco para o cliente e estável: lançamentos novos entram no fim e não bagunçam a página que já foi lida.

`POST /wallets/:id/reconciliation` lê saldo e ledger num snapshot único (`REPEATABLE READ`, somente leitura) e confere três coisas: o saldo guardado bate com a soma do ledger, a sequência não tem buraco, e a cadeia de hash está íntegra. Divergência **não é corrigida**: vai na resposta (`consistent: false`), gera log de erro e incrementa `reconciliation_divergences_total`. Corrigir saldo automaticamente esconderia o bug que causou a divergência.

---

## 11. Mensageria

### Consumidor SQS

O consumidor de `wager-transactions.fifo` chama o mesmo `SubmitWagerTransaction` do HTTP, com a inbox dentro da transação. O ack (delete) só acontece depois do commit. Se o processo morrer entre o commit e o ack, a mensagem volta, a inbox reconhece a `messageId` e o efeito não se repete (há teste derrubando o processo exatamente nesse ponto).

Cada erro é classificado:

- **negócio**: a decisão já ficou gravada na transação. Confirmo a mensagem;
- **permanente** (payload inválido, carteira ou provedor inexistente): mando direto para `wager-transactions-dlq.fifo`, com o motivo num atributo, e só depois apago da fila principal. Reenviar nunca daria certo;
- **transitório** (banco fora, `lock_timeout`, erro inesperado): não confirmo. A mensagem volta com visibilidade crescente (backoff). Depois de 5 entregas, o redrive da fila manda para a DLQ.

Erro inesperado é tratado como transitório de propósito: se for bug, ele acaba na DLQ depois de algumas tentativas, o que é melhor do que confirmar e perder a operação em silêncio.

**Ordem.** O `MessageGroupId` é a carteira. Mensagens do mesmo grupo são processadas em ordem, e se a primeira falha de forma passageira, as seguintes do mesmo grupo são devolvidas sem processar, para não passarem na frente dela. Mesmo assim, a FIFO é otimização: quem garante a correção é o banco. O teste de inbox manda a mesma mensagem duas vezes com a deduplicação do SQS desligada.

**Desligamento.** No `SIGTERM`, o consumidor para de pedir mensagens novas, termina as que já começaram e devolve na hora (visibilidade 0) as que recebeu e não começou. Uma coisa que descobri testando: abortar o long polling no cliente não cancela o receive no servidor, e as mensagens que chegassem nesse intervalo ficariam invisíveis por um visibility timeout inteiro. Então o desligamento espera o receive atual voltar (no máximo `SQS_WAIT_TIME_SECONDS`) e devolve o que veio nele.

### Outbox transacional

Os eventos são gravados em `outbox_messages` na mesma transação da mudança de saldo. Se a transação é desfeita, o evento nunca existiu. Um relay no worker publica em `wager-events.fifo`.

O relay trabalha por carteira, não por evento:

1. numa transação curta, trava com `FOR UPDATE SKIP LOCKED` o evento mais antigo pendente de cada carteira e reserva (lease de 30 s) todos os pendentes dela;
2. fora da transação, publica os eventos de cada carteira em lotes de até 10, na ordem em que aconteceram;
3. na primeira falha de uma carteira, para ali: o evento que falhou ganha nova tentativa com backoff, e os seguintes só são liberados.

Se o processo morrer no meio, o lease vence e outra instância retoma a carteira de onde parou. Várias instâncias, e várias vias dentro de uma instância, publicam ao mesmo tempo sem pegar a mesma carteira. Um índice parcial sobre os pendentes por carteira mantém a reivindicação barata.

A entrega é pelo menos uma vez: um evento pode ser publicado de novo (processo que morre depois de publicar e antes de marcar). Cada evento tem um `eventId` estável, que também é o `MessageDeduplicationId`, e o consumidor deve deduplicar por ele. `WalletBalanceChanged` leva o `walletVersion`, que permite ao consumidor ordenar e detectar buraco.

O lote veio do teste de carga. Publicar um evento por chamada deixava o lag da outbox em 54 s. Mais paralelismo quase não mudou isso: medindo, o LocalStack aceitava ~480 mensagens/s com uma por chamada e mais de 3.000/s em lotes de 10. O caminho completo, inclusive a hipótese que não deu certo, está em [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

O lote tem um preço: o SQS pode recusar um evento do meio do lote e aceitar os seguintes. Esses seguintes já estão na fila e contam como publicados, e o caso é contado em `outbox_order_anomalies_total` e logado. É raro, fica visível e o consumidor tem o `walletVersion` para reordenar.

Mais detalhes em [ADR 004](docs/adr/004-outbox-com-lease.md).

### Eventos

`WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`. Cada um é uma subclasse de `IntegrationEvent`, com `eventType` e `version` no próprio tipo. O envelope tem `correlationId` e `causationId`, e os eventos gerados no reprocessamento mantêm a correlação da requisição original.

---

## 12. Autenticação

O enunciado deixa a autenticação a cargo do candidato e pede um IdP externo, sem autenticação artesanal. Usei **Keycloak** (OIDC), com o realm versionado em `docker/keycloak/realm.json`.

- A aplicação só conhece a porta `IdentityProvider`. O adaptador `JwtIdentityProvider` valida o JWT pela JWKS do Keycloak com `jose`: só RS256, emissor e audiência (`chimp-ledger`) conferidos e 5 s de tolerância de relógio.
- O guard é global e fechado por padrão. A rota precisa ser marcada como pública (`@Public`) para abrir, e as protegidas declaram o escopo que exigem (`@RequireScopes`).
- Cada provedor é um client do Keycloak (`client_credentials`). **O `provider_id` vem do token, não do corpo**: se o corpo disser outro provedor, a resposta é `403`. Consultar a transação de outro provedor pelo id interno devolve `404`, para não confirmar que ela existe.
- Os escopos separam o que o provedor faz do que o backoffice faz. Abrir carteira, ler o ledger completo, reconciliar e ler transações de qualquer provedor ficam só com o backoffice.
- Keycloak fora do ar responde `503`, não `401`: o problema é nosso, e o provedor pode tentar de novo.
- As respostas de erro seguem a RFC 6750 (`WWW-Authenticate`).

Como pede o enunciado, `/health/*` fica aberto, e as mensagens da fila são tratadas como canal interno confiável. Mesmo assim, o `providerId` da mensagem passa pelas mesmas validações de domínio: provedor ativo e com permissão para a moeda.

A autenticação é desligável (`AUTH_ENABLED`). Ligada sem `AUTH_ISSUER_URL`, o processo nem sobe: uma API aberta achando que está protegida é pior do que uma que não sobe.

---

## 13. Observabilidade

- **Logs** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Valores e payloads não vão para o log, e há redaction para os campos sensíveis (há teste conferindo uma linha de log real).
- **Métricas** Prometheus em `/metrics`, na API e no worker:
  - transações por status, tipo e origem;
  - duplicatas;
  - latência;
  - conflitos de lock;
  - desfechos do consumidor (inclusive os retries);
  - DLQ;
  - publicações, falhas e anomalias de ordem da outbox;
  - lag da outbox;
  - falhas de autenticação;
  - divergências de reconciliação.

  O lag é calculado na hora da coleta, direto do banco. Se o banco estiver fora, essa medida sai como `NaN` e as outras continuam saindo.
- **Health**: `/health/live` não depende de nada, e `/health/ready` confere Postgres e SQS de verdade.
- **Dashboard**: o Compose completo sobe Prometheus e um Grafana com o dashboard versionado. Não é obrigatório, mas deixa o comportamento do sistema visível durante o teste de carga.

---

## 14. Estratégia de testes

Os testes de integração e de concorrência usam Postgres, LocalStack e Keycloak reais em containers (Testcontainers). Não há mock de infraestrutura.

- **Unidade**: domínio puro.
- **Integração**: esquema e constraints testados com SQL direto, idempotência, regras, inbox, outbox, consumidor, DLQ, reprocessamento, autenticação e observabilidade.
- **Concorrência**: processos reais da API e do worker.
  - o cenário de duas apostas de 80 sobre 100;
  - a mesma aposta 50 vezes em paralelo;
  - uma simulação com seed reproduzível, 3 instâncias, duplicatas e desordem, comparada com um oráculo simples em memória;
  - recuperação com o processo derrubado depois do commit, com eventos reservados e com `kill -9` no meio da carga.
- **Invariante final**: os testes que movem dinheiro terminam conferindo, no próprio Postgres, que o saldo de cada carteira é igual ao reconstruído pelo ledger e que a sequência não tem buraco.
- **Sabotagens** (`bun run test:mutation`): 11 garantias quebradas de propósito, uma de cada vez. Todas detectadas.
- **Carga** (`bun run test:load`): relatório em [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

---

## 15. Limitações e trade-offs

O que eu sei que não está resolvido, ou que foi uma troca consciente:

- **Carteira quente tem teto.** O lock serializa a carteira: no teste de carga, uma carteira só ficou em ~92 req/s com p99 de ~1 s. Para um jogador real isso é muito; para uma carteira de casa compartilhada não seria. A saída seria particionar o saldo, o que muda o modelo.
- **Lote da outbox pode inverter a ordem** no caso raro de falha no meio do lote. Fica medido, mas o consumidor precisa usar o `walletVersion`.
- **`FAILED` não é gravado** por nenhum fluxo atual (ver seção 7).
- **Outbox e inbox não são limpas.** As linhas publicadas e processadas ficam para sempre. Em produção precisaria de uma rotina de expurgo com retenção definida. A inbox, em particular, só precisa guardar a mensagem pelo tempo em que a fila ainda pode reentregá-la.
- **Ledger sem particionamento nem arquivamento.** A reconciliação lê o ledger inteiro da carteira, o que fica caro com o tempo. Uma saída seria checkpoints de saldo conferidos.
- **Readiness com banco travado.** Se o Postgres parar de responder sem fechar a conexão, a checagem de readiness pode segurar uma conexão do pool até o timeout.
- **A readiness da API também confere o SQS**, porque o enunciado pede. A API em si não depende da fila, então uma queda do SQS tira réplicas da API do balanceador sem necessidade. Em produção eu separaria isso.
- **Fora do escopo:** rate limiting por provedor, mTLS, rotação de segredos e criptografia em repouso. Os segredos do Compose e do realm são de desenvolvimento local, com nome de dev.
- **Números do LocalStack não são números da AWS.** O teste de carga mede o sistema contra um SQS emulado numa máquina só; serve para achar gargalo e comparar antes e depois, não para prometer vazão.
- **O teste de `SIGTERM` com processo real roda só no Linux (CI).** No Windows, o sinal não chega ao processo da mesma forma.
