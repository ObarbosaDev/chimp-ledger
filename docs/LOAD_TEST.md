# Teste de carga

Relatório do teste de carga do chimp-ledger: como rodar, como medi, o que os números mostram e, principalmente, o que eles **não** mostram.

```bash
bun run test:load
# parâmetros (todos opcionais):
LOAD_CONCURRENCY=48 LOAD_DURATION_S=30 LOAD_WALLETS=200 LOAD_INSTANCES=3 bun run test:load
```

O resultado completo de cada execução fica em `test/load/results/` (JSON, fora do Git). As tabelas abaixo são das execuções de 21/11/2026: três para entender o sistema e uma quarta, depois de corrigir o gargalo que elas revelaram.

---

## Ambiente

| | |
|---|---|
| Máquina | notebook, AMD Ryzen 5 5600H (6 núcleos / 12 threads), 15,4 GB de RAM |
| Sistema | Windows 11 (NT 10.0.26300), Docker Desktop 29.9.3 com WSL2 |
| Runtime | Bun 1.4.5 |
| Banco | `postgres:16-alpine` em container, configuração padrão |
| Fila | `localstack/localstack:4.4` (SQS) em container |
| Topologia | 3 processos da API + 1 worker (relay da outbox, consumidor e reprocessamento), todos na mesma máquina |

**Tudo roda na mesma máquina**: o gerador de carga, as 3 APIs, o worker, o Postgres e o LocalStack disputam a mesma CPU, e os dois containers rodam dentro da VM do WSL2. Isso pesa na leitura dos resultados (ver *Limitações*).

## Metodologia

- **Laço fechado.** Cada cliente virtual só manda a próxima requisição quando recebe a resposta da anterior. Assim a vazão medida é a que o sistema sustenta, e a latência não fica inflada por fila do próprio gerador.
- **Requisições distribuídas** entre as 3 instâncias da API em rodízio, como um balanceador faria.
- **Mistura de operações** com seed fixa (reproduzível): ~65% BET, ~15% WIN, ~15% LOSS e ~5% de **reenvio** de uma operação que o mesmo cliente já mandou, que precisa voltar como replay (`200`).
- **Dois cenários de 30 s cada**, em sequência no mesmo ambiente:
  - **distribuído:** 200 carteiras com R$ 5.000,00, mede o caminho normal;
  - **carteira quente:** todos os clientes na mesma carteira, mede o custo do lock por carteira.
- **O que é medido:**
  - latência de cada requisição, do envio até ler o corpo, com p50/p95/p99 pelo método do posto mais próximo (sem interpolar);
  - vazão total (`req/s`) e vazão de transações aplicadas (`201`/s);
  - taxa de erro, contando **só** `5xx` e erro de rede (`409`/`422` são respostas de negócio, não erro);
  - conflitos de lock, pela soma de `lock_conflicts_total` das 3 APIs antes e depois de cada cenário;
  - lag da outbox, amostrado a cada 1 s no `/metrics` do worker, mais o tempo para a outbox esvaziar depois do fim da carga.
- **No fim, as invariantes financeiras em todas as carteiras**, calculadas no próprio Postgres: saldo igual à soma do ledger, contagem de lançamentos, nenhuma chave de idempotência duplicada e nenhum saldo negativo. Velocidade com dinheiro errado não serve para nada.

## Resultados

**Execução 1: padrão (48 clientes, pool de 10 conexões por instância)**

| Cenário | Carteiras | req/s | aplicadas/s | p50 | p95 | p99 | Erros | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|
| distribuído | 200 | **346** | 329 | 126 ms | 283 ms | 344 ms | 0,00% | 0 |
| carteira quente | 1 | **81** | 77 | 608 ms | 1.186 ms | 1.274 ms | 0,00% | 0 |

Outbox: lag máximo **54 s**, esvaziou **23 s** depois do fim da carga.

**Execução 2: 160 clientes (mais pressão que o sistema aguenta)**

| Cenário | Carteiras | req/s | aplicadas/s | p50 | p95 | p99 | Erros | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|
| distribuído | 200 | 339 | 324 | 451 ms | 700 ms | 845 ms | 0,00% | 0 |
| carteira quente | 1 | 79 | 76 | 1.968 ms | 2.432 ms | 2.557 ms | 0,00% | 0 |

Outbox: lag máximo 38 s, esvaziou 14 s depois.

**Execução 3: 48 clientes, pool de 30 conexões por instância**

| Cenário | Carteiras | req/s | aplicadas/s | p50 | p95 | p99 | Erros | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|
| distribuído | 200 | 346 | 329 | 123 ms | 289 ms | 379 ms | 0,00% | 0 |
| carteira quente | 1 | 84 | 80 | 768 ms | 1.138 ms | 1.252 ms | 0,00% | 0 |

**Invariantes nas três execuções:** 201 carteiras, 0 com divergência entre saldo e ledger, 0 chaves de idempotência duplicadas, 0 saldos negativos. Em todas, cerca de 5% das respostas foram `200` (replay das duplicatas), como esperado pela mistura.

## O que os números mostram

**1. O sistema satura em torno de 340 req/s nesta máquina.** Com 160 clientes, a vazão não sobe (339 req/s) e só a latência cresce. É a Lei de Little: 160 clientes ÷ 339 req/s ≈ 0,47 s, exatamente o p50 medido. A partir daí, mais concorrência vira só espera.

**2. O gargalo não é o pool de conexões.** Triplicar o pool (10 → 30 por instância) não mudou a vazão (346 req/s nas duas). O limite está no conjunto: CPU compartilhada entre gerador, APIs, worker e banco, e o custo de cada commit (fsync) dentro do WSL2. Este experimento não isola qual dos dois pesa mais, e eu não vou fingir que isola.

**3. A carteira quente custa ~12 ms por transação, em série.** Com todos os clientes na mesma carteira, a vazão cai para ~80 req/s, ou seja, ~12 ms por transação, uma atrás da outra. É o custo esperado do lock pessimista: a carteira vira uma fila ordenada. Os ~12 ms são o tempo que a linha fica travada (uma transação SQL com várias idas ao banco mais o commit). Carteiras diferentes não sofrem com isso: elas andam em paralelo, como mostra o cenário distribuído.

**4. Zero conflitos de lock, mesmo com p99 acima do `lock_timeout`.** Na execução 2, o p99 da carteira quente foi 2,56 s, acima dos 2 s de `lock_timeout`, e ainda assim nenhuma transação desistiu do lock. A espera estava **antes** do banco, na fila do pool: no máximo 30 conexões chegam ao Postgres ao mesmo tempo, e cada uma espera no máximo ~29 × 12 ms ≈ 350 ms pelo lock. Na prática, o pool funciona como uma segunda barreira que impede uma carteira quente de prender o banco inteiro. O `lock_timeout` continua lá para o caso em que essa conta não fecha (pool maior, transação mais lenta).

**5. O gargalo real é a publicação da outbox.** Durante a carga, o lag chegou a 54 s: o worker publica bem menos eventos por segundo do que a API gera (~330 transações/s viram ~660 eventos/s). Isso vem de duas escolhas conscientes:
- **um evento por chamada, em ordem, por carteira:** é o que garante que os eventos de uma carteira nunca saem fora de ordem, mesmo com falha parcial;
- **um único worker** no teste.

Nada se perdeu: a outbox esvaziou em ~20 s depois do fim da carga, e o lag aparece na métrica `outbox_lag_seconds`, que é o que um alerta precisa observar. Mas, com essa taxa contínua, o lag cresceria sem parar. A seção seguinte conta como isso foi resolvido.

**6. Correção não degradou com a carga.** 0% de erro de infraestrutura, todas as duplicatas viraram replay e as invariantes fecharam em todas as carteiras, nas três execuções.

---

## Antes e depois: o gargalo da outbox

**Primeira hipótese: falta de paralelismo. Errada.** Coloquei 4 vias de publicação no mesmo worker (cada via reivindica carteiras diferentes, então a ordem por carteira continua garantida). Rodei a carga de novo: o lag foi de 54 s para 48 s. Quase nada. Paralelismo não era o problema.

**Medir antes de chutar de novo.** Separei as duas metades do caminho da outbox:

- **Reivindicação:** `EXPLAIN ANALYZE` com 20 mil eventos pendentes em 200 carteiras deu ~70 ms por rodada. A consulta busca o evento mais antigo de cada carteira (`DISTINCT ON`), e sem índice nessa ordem o Postgres varre e ordena todos os pendentes a cada rodada. É um custo real, que cresce com o acúmulo, mas sozinho não explicava 54 s.
- **Publicação:** um benchmark direto contra o SQS do LocalStack mostrou o teto:

| Forma de publicar | Vazão |
|---|---|
| 1 mensagem por chamada, 50 concorrentes | 474 msg/s |
| 1 mensagem por chamada, 200 concorrentes | 495 msg/s |
| 10 mensagens por chamada, 50 concorrentes | **3.360 msg/s** |

**Essa era a causa.** O custo está em cada chamada, não na concorrência: com uma mensagem por chamada, o teto fica perto de 480 msg/s, e a API gera ~660 eventos/s. O lag crescer é aritmética.

**A correção:**
1. **Lote por carteira:** os eventos de uma carteira vão em lotes de até 10, na ordem. Numa fila FIFO o SQS enfileira o lote na ordem enviada.
2. **Índice parcial** `(aggregate_id, occurred_at, id) where published_at is null`, para a reivindicação ler só a cabeça de cada carteira.

**O preço do lote, tratado às claras.** Num lote, o SQS devolve um resultado por mensagem. Se ele recusar só uma do meio e aceitar as seguintes, essas seguintes já estão na fila na frente da que falhou. Esse caso é raro (falha de rede ou throttling derruba a chamada inteira, e aí a ordem fica preservada), mas pode acontecer. Por isso:
- o que o SQS aceitou conta como publicado, porque está na fila de verdade;
- o evento que falhou ganha nova tentativa, e os que nem foram enviados voltam para a outbox;
- o caso vira a métrica `outbox_order_anomalies_total` e um log de alerta, e o consumidor tem o `walletVersion` de cada evento para reordenar.

**Execução 4: mesmos parâmetros da execução 1, com lote e índice**

| Cenário | Carteiras | req/s | aplicadas/s | p50 | p95 | p99 | Erros | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|
| distribuído | 200 | 330 | 314 | 134 ms | 277 ms | 404 ms | 0,00% | 0 |
| carteira quente | 1 | 92 | 88 | 570 ms | 910 ms | 1.057 ms | 0,00% | 0 |

| Outbox | Antes (execução 1) | Depois (execução 4) |
|---|---|---|
| Lag máximo durante a carga | 54 s | **4,7 s** |
| Tempo para esvaziar depois da carga | 23 s | **0,2 s** |

A vazão da API ficou na mesma faixa (ela não dependia da outbox), as invariantes continuaram íntegras e a outbox passou a acompanhar a carga.

## Limitações (o que este teste não prova)

- **Gerador e sistema na mesma máquina.** O gerador consome CPU que o sistema poderia usar. O número absoluto de req/s é deste notebook, não da aplicação. O valor do teste está nas **relações** (distribuído × carteira quente, pool 10 × 30, lag × vazão) e nas invariantes.
- **Docker Desktop no Windows.** Postgres e LocalStack rodam dentro da VM do WSL2. O custo de I/O e de rede entre host e VM não é o de um servidor de produção.
- **LocalStack não é SQS.** As latências de fila não são as da AWS, então o lag da outbox aqui é indicativo, não uma previsão.
- **Rodadas curtas (30 s) e sem aquecimento separado.** Os primeiros segundos incluem a abertura de conexões do pool. Para uma conclusão estável, o ideal seria aquecer e medir por vários minutos, repetindo cada cenário.
- **Postgres com configuração padrão.** Nada de tuning (`shared_buffers`, `synchronous_commit` etc.). Foi de propósito: medir a aplicação, não o ajuste do banco.
- **Só a API HTTP foi carregada.** O consumidor SQS usa o mesmo caso de uso, mas não foi medido sob carga neste relatório.
