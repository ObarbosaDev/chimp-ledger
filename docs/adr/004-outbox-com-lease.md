# ADR 004: Outbox com lease, por carteira e em lote

**Status:** aceita

## Contexto

Os eventos de integração não podem ser publicados antes do commit, e não podem se perder se o processo morrer depois do commit. Vários publicadores rodam ao mesmo tempo (réplicas do worker e várias vias dentro de cada uma). Os consumidores esperam os eventos de uma carteira na ordem em que aconteceram.

## Decisão

Os eventos são gravados em `outbox_messages` na mesma transação da mudança de saldo. O relay publica em três passos:

1. **Reivindica por carteira.** Numa transação curta, trava com `FOR UPDATE SKIP LOCKED` o evento mais antigo pendente de cada carteira e marca um lease (30 s) em todos os pendentes dela. Outro publicador pula essa carteira até o lease vencer.
2. **Publica fora da transação**, em lotes de até 10 eventos por carteira, na ordem. Nenhuma conexão fica presa esperando a rede.
3. **Liquida.** Marca como publicados os aceitos. Na primeira falha de uma carteira, o evento que falhou ganha nova tentativa com backoff, e os seguintes só são liberados.

Um índice parcial sobre os pendentes por carteira mantém a reivindicação barata.

## Alternativas consideradas

**Publicar dentro da transação.** Segura conexão e lock enquanto espera o SQS, e se o SQS aceitar mas o commit falhar, o evento sai sem o fato ter acontecido.

**Reivindicar por evento** (`SKIP LOCKED` em cada linha). Dois publicadores podem pegar eventos diferentes da mesma carteira e publicá-los fora de ordem.

**Um evento por chamada ao SQS.** Era a primeira versão. O teste de carga mostrou o lag da outbox em 54 s. Mais paralelismo não resolveu: o limite estava no custo de cada chamada (~480 mensagens/s no LocalStack, contra mais de 3.000/s em lotes de 10).

## Consequências

- Processo que morre com eventos reservados: o lease vence e outra instância retoma a carteira de onde parou.
- Entrega pelo menos uma vez: um evento pode ser publicado de novo. O `eventId` é estável e é o `MessageDeduplicationId`, e o consumidor deve deduplicar por ele.
- No caso raro de o SQS recusar um evento do meio de um lote e aceitar os seguintes, a ordem se inverte para aquela carteira. Os aceitos contam como publicados, o caso é contado em `outbox_order_anomalies_total` e logado, e o `walletVersion` no evento permite ao consumidor reordenar.
- Depois da mudança, o lag máximo sob a mesma carga caiu de 54 s para 4,7 s (detalhes em `docs/LOAD_TEST.md`).
