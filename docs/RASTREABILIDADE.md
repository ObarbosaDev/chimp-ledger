# Rastreabilidade: enunciado → código → prova

Cada exigência do desafio, onde ela está implementada e qual teste prova que ela vale. Os testes rodam contra Postgres, LocalStack e Keycloak reais (Testcontainers), e as provas de concorrência usam processos reais da API e do worker.

Como conferir tudo de uma vez:

```bash
bun test                 # suíte completa
bun run test:mutation    # sabota cada garantia e confere que algum teste percebe
bun run test:load        # carga com verificação das invariantes no final
```

---

## Falhas eliminatórias (seção 14)

| Falha eliminatória | Por que não acontece | Prova |
|---|---|---|
| `number` para dinheiro | `Money` usa `decimal.js`; a entrada só aceita string com duas casas; no banco é `NUMERIC(19,2)` | `test/unit/shared/money.test.ts` · sabotagem 7 |
| Saldo negativo causado por race | Lock por carteira (`FOR UPDATE`), `version` no `WHERE` do update, `UNIQUE (wallet_id, sequence)` no ledger e `CHECK (balance >= 0)` | `same-wallet.test.ts`: *várias apostas concorrentes nunca deixam o saldo negativo* · sabotagem 1 |
| Débito ou crédito duplicado | Chave de idempotência única por provedor no banco, inbox por `(consumer, messageId)`, reversão única por índice parcial | `same-wallet.test.ts`: *a mesma aposta enviada 50 vezes em paralelo debita uma vez só* · `recovery.test.ts`: *worker morre depois do commit e antes do ack* |
| Idempotência só em memória | Nada de cache: `UNIQUE (provider_id, idempotency_key)` + `INSERT ... ON CONFLICT DO NOTHING` | `schema-constraints.test.ts`: *chave de idempotência é única por provedor* · simulação com 3 instâncias |
| Correta só com uma instância | Toda garantia está no banco; nenhum estado compartilhado em memória | `multi-instance-simulation.test.ts` (3 processos, seed reproduzível) · `recovery.test.ts`: *kill -9 no meio da carga* |
| Evento publicado antes do commit | Evento vai para a outbox na mesma transação SQL; o relay só lê o que comitou | `outbox-relay.test.ts`: *evento de transação que deu rollback nunca existe na outbox* |
| Ausência de ledger auditável | Ledger imutável (trigger + sem permissão de `UPDATE`/`DELETE`), encadeado por hash, reconciliação que aponta o elo quebrado | `schema-constraints.test.ts`: *ledger não aceita UPDATE nem DELETE* · `ledger-reconciliation.test.ts` · sabotagens 8 e 9 |
| Testes que trocam Postgres e SQS por mocks | Testcontainers em todos os testes de integração e concorrência | `test/support/test-stack.ts` · CI no GitHub Actions |

## Restrições invioláveis (seção 5)

| Restrição | Implementação | Prova |
|---|---|---|
| Sem cache em memória como garantia de idempotência | `wager-transaction.repository.ts` (`insertIfAbsent`) | `submit-wager.test.ts`: replay e conflito |
| Não confiar só no SQS FIFO | Inbox no banco; o teste manda a mesma mensagem com deduplicação do SQS desligada | `wager-consumer.test.ts`: *a mesma mensagem entregue duas vezes aplica o efeito uma vez só* |
| Não publicar antes do commit | `OutboxRepository.enqueue` dentro do `UnitOfWork` | `outbox-relay.test.ts` (rollback) |
| Ledger nunca sobrescrito nem excluído | Trigger `trg_ledger_immutable` + grants da migração inicial | `schema-constraints.test.ts` (dono e aplicação) |
| Sem lock global | Lock por linha da carteira | `same-wallet.test.ts`: *carteiras diferentes processam em paralelo* |
| Sem read → calculate → update solto | `findByIdForUpdate` + `saveMovement` com versão no `WHERE` | `same-wallet.test.ts`: *cenário obrigatório* · sabotagem 1 |
| Garantias no esquema | `migrations/` (CHECK, UNIQUE, triggers diferidos, `search_path` fixo) | `schema-constraints.test.ts` (18 testes, SQL direto) |
| Migrações reversíveis | `up`/`down` em todas | `schema-constraints.test.ts`: *todas as migrações descem e sobem de novo sem sobrar nada* |

## Modelo de domínio (seção 6)

| Exigência | Implementação | Prova |
|---|---|---|
| Construtor privado + `create`/`from`/`rehydrate` | Todas as entidades de `src/**/domain` | `test/architecture/dependency-rule.test.ts` (domínio sem ORM nem Nest) |
| `Money` imutável, escala 2, recusa NaN/Infinity/notação científica/>2 casas/negativo | `src/shared/domain/money.ts` | `money.test.ts` |
| Moedas diferentes lançam erro | `assertSameCurrency` | `money.test.ts`, `wallet.test.ts` |
| Uma carteira por jogador + moeda | `UNIQUE (player_id, currency)` | `wallets.http.test.ts` (409) |
| `version` começa em 1 e sobe só com o saldo | `Wallet` + trigger `check_wallet_update` | `wallet.test.ts` · `schema-constraints.test.ts` |
| Toda alteração de saldo tem lançamento (e vice-versa) | Trigger diferido `check_wallet_matches_ledger` | `schema-constraints.test.ts`: *mudar saldo sem lançamento no ledger falha no commit* |
| Transições explícitas; estados finais não mudam | `WagerTransaction` + trigger `check_wager_transaction_update` | `wager-transaction.test.ts` · `schema-constraints.test.ts`: *transação em estado final não muda mais* |
| `OPENING` interna | Enum do contrato sem `OPENING` + `CHECK` no banco | `submit-wager.test.ts` (400) · `schema-constraints.test.ts` |
| Lançamento imutável, aritmética validada | `WalletLedgerEntry` congelado + `CHECK` aritmético | `wallet-ledger-entry.test.ts` · `schema-constraints.test.ts` |
| Inbox, saldo, ledger e outbox na mesma transação | `SubmitWagerTransaction` + `MikroOrmUnitOfWork` | `outbox-relay.test.ts` (rollback) · `recovery.test.ts` |

## Regras de negócio (seção 7)

| Regra | Prova (`test/integration/submit-wager.test.ts` salvo indicação) |
|---|---|
| BET debita; recusa sem saldo com `INSUFFICIENT_FUNDS` | *saldo insuficiente → 422 INSUFFICIENT_FUNDS, sem lançamento, auditável* |
| WIN credita e pode referenciar a BET | *WIN credita e pode referenciar a BET da rodada* |
| LOSS sem movimento e sem lançamento | *LOSS registra sem mexer no saldo e sem lançamento* |
| REFUND só de BET, uma vez | *REFUND devolve a BET uma única vez* |
| ROLLBACK de BET/WIN/REFUND, uma vez, mesmo trocando o tipo | *ROLLBACK de BET depois de REFUND também é recusado* · `schema-constraints.test.ts` |
| Referência do mesmo provedor, jogador, carteira, moeda e rodada; valor igual | *REFUND de outra rodada → REFERENCE_MISMATCH*, *AMOUNT_MISMATCH* · `reference-policy.test.ts` |
| Reversão que negativaria o saldo tem código próprio | *ROLLBACK de WIN já gasto → NEGATIVE_BALANCE_PREVENTED* |
| Replay devolve o saldo daquele momento | *replay idêntico devolve a mesma resposta e não debita de novo* |
| Referência ausente → `PENDING_REFERENCE` e reprocessamento com backoff e limite | *REFUND antes da BET → 202* · `pending-reference.test.ts` (backoff, 10 tentativas, TTL de 1 h) |
| Códigos de falha estáveis e legíveis por máquina | `failure-code.ts` (ação por código) · `payload-hash-and-retry.test.ts` |
| Interpretação documentada: aposta liquidada não aceita nova liquidação nem reembolso | `describe('liquidação da aposta')` (5 cenários) · sabotagem 5 |

## Concorrência (seção 8)

| Cenário | Prova |
|---|---|
| 100,00 de saldo, duas apostas de 80,00 simultâneas | `same-wallet.test.ts`: *cenário obrigatório* (1 `PROCESSED`, 1 `REJECTED`, saldo 20,00, 1 débito) |
| Vários workers na mesma carteira | `pending-reference.test.ts`: *dois workers ao mesmo tempo aplicam o REFUND uma vez só* |
| Carteiras diferentes em paralelo | `same-wallet.test.ts` |
| Três ou mais instâncias | `multi-instance-simulation.test.ts` · `recovery.test.ts` |

## API HTTP (seção 9)

| Exigência | Prova |
|---|---|
| Criar carteira com `OPENING` + lançamento na mesma transação; duplicada é 409 | `wallets.http.test.ts` |
| `Idempotency-Key` obrigatório; mesmo conteúdo = replay, conteúdo diferente = 409 | `submit-wager.test.ts` |
| `payloadHash` de JSON canônico (chaves ordenadas) | `payload-hash-and-retry.test.ts` · `canonical-json.test.ts` |
| Status distintos para payload inválido (400), conflito (409), regra de negócio (422), pendente (202) e falha transitória (503) | `submit-wager.test.ts` · `auth.test.ts` (503 com Keycloak fora) |
| Ledger com cursor estável e opaco | `ledger-reconciliation.test.ts`: *lançamento novo no meio da leitura não bagunça o que já foi lido* |
| Reconciliação que sinaliza, registra, conta e não corrige | `ledger-reconciliation.test.ts` · `observability.test.ts`: *divergência de reconciliação vira métrica* |
| `/health/live` e `/health/ready` | `observability.test.ts` · `worker.test.ts` |

## SQS (seção 10)

| Exigência | Prova (`wager-consumer.test.ts` salvo indicação) |
|---|---|
| Mesmo caso de uso do HTTP | `SubmitWagerTransaction` chamado pelos dois |
| Deduplicação pela inbox | *a mesma mensagem entregue duas vezes aplica o efeito uma vez só* |
| Ack só depois do commit | *processa a mensagem, grava a inbox e só então apaga da fila* · `recovery.test.ts` |
| Negócio → ack; transitório → retry com backoff; permanente → DLQ | *rejeição de negócio é final*, *falha transitória não confirma*, *mensagem permanentemente inválida vai direto para a DLQ* |
| Limite de tentativas antes da DLQ | *falha transitória insistente vai para a DLQ pelo redrive depois de 5 entregas* |
| SIGTERM: termina ou devolve a visibilidade | *stop durante o long polling devolve na hora o que chegou* · `recovery.test.ts` (SIGTERM, no CI) |
| Ordem por carteira mesmo com falha | *falha passageira na primeira mensagem do grupo segura as seguintes* |

## Outbox (seção 11)

| Exigência | Prova (`outbox-relay.test.ts` salvo indicação) |
|---|---|
| Atomicidade com a transação financeira | *evento de transação que deu rollback nunca existe na outbox* |
| Vários publicadores sem perder nem duplicar | *dois relays concorrentes nunca publicam o mesmo evento* · *várias vias no mesmo relay* · sabotagem 10 |
| Processo morre antes de publicar e outro assume | *processo que morreu segurando o lease* · `recovery.test.ts`: *relay morre com eventos reservados* |
| Eventos mínimos com envelope versionado e `data` só com `MoneyProps` | `events.test.ts` |

## Observabilidade (seção 12)

| Exigência | Prova |
|---|---|
| Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, sem valores | `observability.test.ts`: *a transação gera uma linha JSON com os ids de rastreio e sem valores* |
| Métricas: status, duplicatas, retries, DLQ, conflitos de lock, lag da outbox, latência | `observability.test.ts` · `worker.test.ts` · `metrics.test.ts` |
| Health de vivacidade e prontidão separados | `observability.test.ts` |

## Testes obrigatórios (seção 13)

| Pedido | Onde |
|---|---|
| Unidade: Money, Wallet, regras, moeda, idempotência | `test/unit/` |
| Integração: migrações e restrições, atomicidade, inbox, editores concorrentes, retry e DLQ, recuperação após reinício | `test/integration/` · `test/concurrency/recovery.test.ts` |
| A mesma aposta 50 vezes em paralelo | `same-wallet.test.ts` |
| Disputa de saldo na mesma carteira | `same-wallet.test.ts` |
| Carteiras separadas em paralelo | `same-wallet.test.ts` |
| Três ou mais processos | `multi-instance-simulation.test.ts` |
| Worker morto depois do commit e antes do ack | `recovery.test.ts` |
| Dois publicadores na mesma outbox | `outbox-relay.test.ts` |
| ROLLBACK ou REFUND antes da referência | `pending-reference.test.ts` · `submit-wager.test.ts` |
| Reinício com consistência final | `recovery.test.ts`: *kill -9 no meio da carga: tudo fecha no final* |
| Invariante final `saldo == ledger` | `test/support/invariants.ts`, usada nos testes de integração, concorrência e carga |

## Diferenciais

| Diferencial | Onde |
|---|---|
| Autenticação com provedor de identidade (Keycloak) | `src/auth/` · `docker/keycloak/realm.json` · `auth.test.ts` (Keycloak real) |
| Teste de carga com relatório | `bun run test:load` · [`docs/LOAD_TEST.md`](LOAD_TEST.md) |
| Dashboard | `docker compose --profile app up` · Grafana em `http://localhost:3030` |
| Sabotagens dirigidas | `bun run test:mutation`: 11 de 11 detectadas |
