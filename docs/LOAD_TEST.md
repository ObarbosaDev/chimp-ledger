# Teste de carga

Relatório do teste de carga do chimp-ledger: como rodar, como medi, o que os números mostram e, principalmente, o que eles **não** mostram.

```bash
bun run test:load
# parâmetros (todos opcionais):
LOAD_CONCURRENCY=48 LOAD_DURATION_S=30 LOAD_WALLETS=200 LOAD_INSTANCES=3 bun run test:load
```

O resultado completo de cada execução fica em `test/load/results/` (JSON, fora do Git). As tabelas abaixo são das execuções de 21/11/2026.

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

Nada se perde: a outbox esvaziou em ~20 s depois do fim da carga, e o lag aparece na métrica `outbox_lag_seconds`, que é o que um alerta precisa observar. Mas, em produção, com essa taxa contínua, o lag cresceria sem parar. Os próximos passos, em ordem de custo:
1. **mais workers:** a reivindicação por carteira com lease já permite isso, porque cada carteira só fica com um relay por vez;
2. **lote por carteira:** enviar os eventos consecutivos de uma carteira num único `SendMessageBatch`, parando no primeiro que falhar;
3. **mais carteiras por rodada e intervalo menor** entre rodadas quando há fila.

**6. Correção não degradou com a carga.** 0% de erro de infraestrutura, todas as duplicatas viraram replay e as invariantes fecharam em todas as carteiras, nas três execuções.

## Limitações (o que este teste não prova)

- **Gerador e sistema na mesma máquina.** O gerador consome CPU que o sistema poderia usar. O número absoluto de req/s é deste notebook, não da aplicação. O valor do teste está nas **relações** (distribuído × carteira quente, pool 10 × 30, lag × vazão) e nas invariantes.
- **Docker Desktop no Windows.** Postgres e LocalStack rodam dentro da VM do WSL2. O custo de I/O e de rede entre host e VM não é o de um servidor de produção.
- **LocalStack não é SQS.** As latências de fila não são as da AWS, então o lag da outbox aqui é indicativo, não uma previsão.
- **Rodadas curtas (30 s) e sem aquecimento separado.** Os primeiros segundos incluem a abertura de conexões do pool. Para uma conclusão estável, o ideal seria aquecer e medir por vários minutos, repetindo cada cenário.
- **Postgres com configuração padrão.** Nada de tuning (`shared_buffers`, `synchronous_commit` etc.). Foi de propósito: medir a aplicação, não o ajuste do banco.
- **Só a API HTTP foi carregada.** O consumidor SQS usa o mesmo caso de uso, mas não foi medido sob carga neste relatório.
