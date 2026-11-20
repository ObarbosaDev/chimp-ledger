# chimp-ledger

Carteira e ledger para apostas distribuídas. O serviço recebe operações de vários provedores de jogos (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP e por SQS, e continua correto quando essas mensagens chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo em várias instâncias**.

Construído para o desafio técnico de Backend da Jungle Gaming.

---

## O problema, em uma frase

Dinheiro não pode aparecer nem sumir. Todo o resto do projeto existe para defender essa frase contra quatro situações que vão acontecer em produção:

| Situação | Exemplo | O que eu não posso deixar acontecer |
|---|---|---|
| **Duplicação** | o provedor reenvia a mesma BET porque não recebeu resposta | debitar duas vezes |
| **Desordem** | o REFUND chega antes da BET que ele desfaz | rejeitar uma operação válida só porque a fila trocou a ordem |
| **Concorrência** | duas apostas de 80 disputam um saldo de 100 em instâncias diferentes | saldo negativo, ou as duas passarem |
| **Falha no meio** | o processo morre depois do commit e antes de confirmar a mensagem | perder o evento, ou aplicar de novo na reentrega |

---

## Como cada garantia é sustentada

A regra que guiou o projeto: **uma garantia financeira não pode depender de uma camada só**. Toda invariante importante é protegida pelo domínio *e* pelo banco, e tem um teste que tenta quebrá-la.

| Garantia | No domínio | No banco | Teste que prova |
|---|---|---|---|
| Dinheiro exato | `Money` com `decimal.js`, entrada só com 2 casas | `NUMERIC(19,2)` | `test/unit/shared/money.test.ts` |
| Saldo nunca negativo | `Wallet.debit` recusa | `CHECK (balance >= 0)` | `schema-constraints.test.ts` |
| Saldo só muda com lançamento | `debit`/`credit` sempre devolvem o lançamento | trigger **diferido** confere no commit | `schema-constraints.test.ts` |
| Ledger imutável | entidade congelada, sem métodos de escrita | trigger bloqueia `UPDATE`/`DELETE`/`TRUNCATE` + app sem permissão | `schema-constraints.test.ts` |
| Ledger encadeado | cada lançamento leva o hash do anterior | trigger exige sequência, saldo e `prev_hash` contínuos | `wallet-ledger-entry.test.ts` |
| Uma carteira por jogador + moeda | — | `UNIQUE (player_id, currency)` | `wallets.http.test.ts` |
| Reverter só uma vez | `evaluateReference` | índice único parcial | `schema-constraints.test.ts` |
| Estado final é final | transições lançam erro | trigger bloqueia mudança de status terminal | `wager-transaction.test.ts` |
| Idempotência persistente | `payloadHash` canônico | `UNIQUE (provider_id, idempotency_key)` | `schema-constraints.test.ts` (fluxo HTTP em implementação) |

> **Por que no banco também?** Porque bug acontece, e SQL manual também. Se um dia alguém atualizar um saldo direto no Postgres sem o lançamento correspondente, o commit falha. A aplicação não precisa ser perfeita para o dinheiro ficar certo.

---

## Arquitetura

Monólito modular, com módulos separados em `domain` / `application` / `infrastructure`. O domínio não conhece NestJS, MikroORM nem Bun, e existe um teste (`test/architecture`) que falha se alguém quebrar essa fronteira.

```mermaid
flowchart LR
  P[Provedor] -->|HTTP + Idempotency-Key| API
  P -->|SQS FIFO| Q[(wager-transactions.fifo)]
  Q --> W[Worker]
  API --> UC[SubmitWagerTransaction]
  W --> UC
  UC -->|uma transação SQL| DB[(PostgreSQL)]
  DB -->|outbox| R[Relay da outbox]
  R --> E[(wager-events.fifo)]
  Q -. 5 falhas .-> DLQ[(wager-transactions-dlq.fifo)]
```

**Uma porta só para o dinheiro.** HTTP e fila chamam o mesmo caso de uso. Não existe outro código que escreva em `wallets` ou no ledger.

**O fluxo de uma aposta** (dentro de uma única transação SQL):

```mermaid
sequenceDiagram
  participant C as HTTP / SQS
  participant U as SubmitWagerTransaction
  participant DB as PostgreSQL
  C->>U: operação + chave de idempotência
  U->>DB: SELECT carteira FOR UPDATE (lock por carteira)
  U->>DB: INSERT transação ON CONFLICT DO NOTHING
  alt chave já existe
    U-->>C: mesmo hash → replay / hash diferente → 409
  else nova
    U->>DB: resolve referência (se houver)
    U->>DB: UPDATE saldo + INSERT lançamento + status
    U->>DB: INSERT inbox + outbox
    DB-->>U: COMMIT (trigger diferido confere saldo × ledger)
    U-->>C: resultado
  end
```

### Decisões principais

- **Lock pessimista por carteira** (`SELECT … FOR UPDATE`). A disputa só existe dentro da mesma carteira, então carteiras diferentes andam em paralelo e a carteira quente vira uma fila ordenada. Escolhi isso em vez de lock otimista porque, numa carteira muito disputada, o otimista vira uma tempestade de retries.
- **`lock_timeout` de 2s.** Carteira travada demais não prende conexão: vira erro transitório (`503` no HTTP, nova tentativa na fila).
- **Ledger encadeado por hash.** Cada lançamento guarda o hash do anterior. Trigger e permissão impedem alteração pela aplicação, e a corrente acusa até alteração feita por um DBA.
- **Replay devolve o saldo daquele momento**, não o atual. A transação guarda um snapshot do saldo ao ficar final.
- **Domínio puro + `EntitySchema`.** As entidades de domínio têm construtor privado e fábricas (`create`, `rehydrate`); a persistência fica em schemas e mappers separados.
- **Escrita explícita no repositório** (`insert`/`nativeUpdate` em ordem) em vez do flush automático do Unit of Work, porque há FK entre carteira, transação e lançamento, e um trigger que confere tudo no commit.

---

## Stack

| | Escolha | Por quê |
|---|---|---|
| Runtime | **Bun 1.x** | runtime, gerenciador de pacotes e test runner num binário só |
| Framework | **NestJS 11 + Fastify** | DI explícito, Fastify com limite de body nativo |
| ORM | **MikroORM 6** | `EntityManager.transactional`, `LockMode`, migrações reversíveis |
| Banco | **PostgreSQL 16** | `NUMERIC` exato, triggers, constraints diferidas |
| Fila | **SQS FIFO (LocalStack)** | DLQ por redrive, agrupamento por carteira |
| Dinheiro | **decimal.js** | nada de `number` encostando em valor |
| Validação | **zod** (`.strict()`) | campo desconhecido é recusado, não ignorado |
| Testes | **bun test + Testcontainers** | Postgres e LocalStack reais, nada de mock de infra |
| Qualidade | **TypeScript strict + Biome** | `noUncheckedIndexedAccess`, lint e format rápidos |

---

## Rodando localmente

**Pré-requisitos:** [Bun 1.x](https://bun.sh) e Docker (Desktop ou Engine) com Compose.

```bash
bun install
docker compose up -d --wait        # Postgres 16 + LocalStack (SQS)
cp .env.example .env
bun run migration:up               # cria esquema, triggers e permissões
bun run start:api                  # http://localhost:3000
```

O Postgres sobe com dois usuários: `chimp_migrator`, dono das tabelas e usado só nas migrações, e `chimp_app`, usado pela aplicação, **sem permissão** de `UPDATE`/`DELETE` no ledger.

Para derrubar tudo e apagar os dados: `docker compose down -v`.

---

## API

### Carteiras

```bash
# abrir carteira (gera OPENING + lançamento de crédito na mesma transação)
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# {"id":"…","playerId":"0192f28f-…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

curl http://localhost:3000/wallets/<walletId>
```

### Mapa de status

O mesmo em todos os endpoints, para o provedor decidir **sem ler a mensagem de erro**:

| Status | Significado | O provedor deve |
|---|---|---|
| `200` / `201` | processado (`200` em replay) | seguir |
| `202` | aceito, aguardando a transação referenciada | consultar depois |
| `400` | payload inválido | corrigir antes de reenviar |
| `404` | recurso não existe | corrigir |
| `409` | conflito de idempotência ou duplicidade | não reenviar igual |
| `422` | recusado por regra de negócio (ver `failureCode`) | não insistir |
| `503` | falha temporária nossa (`Retry-After`) | reenviar depois |

Erros sempre no formato `{ "code": "...", "message": "...", "retryable": false }`.

### Códigos de falha

Cada `failureCode` vem com uma ação recomendada (`src/wagering/domain/failure-code.ts`):

| Código | Ação |
|---|---|
| `INSUFFICIENT_FUNDS` | desistir |
| `NEGATIVE_BALANCE_PREVENTED` | desistir (reversão que deixaria saldo negativo; pede análise) |
| `ALREADY_REVERSED` | desistir |
| `REFERENCE_NOT_PROCESSED` | desistir |
| `REFERENCE_NOT_FOUND` · `REFERENCE_MISMATCH` · `INVALID_REFERENCE_KIND` · `AMOUNT_MISMATCH` · `CURRENCY_MISMATCH` · `WALLET_PLAYER_MISMATCH` | corrigir o payload |

---

## Testes

```bash
bun run test:unit          # domínio puro + regra de arquitetura (rápido, sem Docker)
bun run test:integration   # Postgres e LocalStack reais via Testcontainers
bun test                   # tudo
bun run typecheck && bun run lint
```

Os testes de integração sobem containers próprios por arquivo, então nenhum teste enxerga dado de outro. Precisa do Docker rodando.

Destaques do que é testado contra o banco real:
- alterar saldo sem lançamento → o **commit** falha;
- `UPDATE` no ledger → recusado pelo trigger e, para o usuário da aplicação, por falta de permissão;
- lançamento que não encadeia no anterior → recusado;
- REFUND e depois ROLLBACK da mesma BET → o segundo é recusado pelo índice único;
- a migração desce e sobe de novo sem sobrar nada.

---

## Estrutura

```
src/
  shared/      Money, erros de domínio, JSON canônico, config, banco, HTTP
  wallet/      Wallet, ledger encadeado, abertura e consulta
  wagering/    WagerTransaction, regras de referência, códigos de falha, eventos
  messaging/   inbox, outbox, envelope de eventos, topologia SQS
  bootstrap/   montagem do Nest (api)
migrations/    SQL escrito à mão, com up e down
docker/        script de papéis do Postgres
test/
  unit/ · integration/ · architecture/ · support/
```

---

## Status

O desafio tem prazo de 3 dias e o projeto está sendo entregue em fatias verticais, cada uma testada antes da próxima.

- [x] Domínio: `Money`, `Wallet`, ledger encadeado, `WagerTransaction`, regras de referência, inbox/outbox, eventos
- [x] Esquema com garantias no banco (constraints, triggers, permissões) e migrações reversíveis
- [x] Abertura e consulta de carteira via HTTP, mapa único de erros
- [ ] Submissão de transações (`POST /wagering/transactions`) com idempotência
- [ ] Testes de concorrência com várias instâncias reais
- [ ] Relay da outbox, consumidor SQS com DLQ e desligamento gracioso
- [ ] Reprocessamento de referências pendentes com backoff
- [ ] Ledger paginado e reconciliação
- [ ] Logs estruturados, métricas e health checks
- [ ] Autenticação com Keycloak
- [ ] Teste de carga
- [ ] `ARCHITECTURE.md` com as decisões e trade-offs

---

## Notas de construção

Algumas coisas que só apareceram na hora de rodar contra infraestrutura de verdade:

- **Nome de constraint repetido.** O Postgres dá nome automático para `CHECK` de coluna (`<tabela>_<coluna>_check`), e eu tinha batizado uma constraint de tabela com exatamente esse nome. A migração quebrou na hora, e isso foi bom: um nome ambíguo ia confundir a leitura de erro depois.
- **Uma função de trigger para duas tabelas.** A checagem "saldo bate com o ledger" dispara pela carteira e pelo lançamento, e `NEW` tem campos diferentes em cada tabela. Resolvi olhando `TG_TABLE_NAME`.
- **CRLF quebra script de container.** No Windows o Git converte quebra de linha por padrão; `.gitattributes` fixa LF para o repositório inteiro.
- **`emitDecoratorMetadata` no Bun.** Para não depender de como o runtime emite metadata, todo construtor do Nest usa `@Inject` explícito.
