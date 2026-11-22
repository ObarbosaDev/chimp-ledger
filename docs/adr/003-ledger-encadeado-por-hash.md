# ADR 003: Ledger encadeado por hash

**Status:** aceita

## Contexto

O ledger precisa ser auditável e imutável, e o saldo materializado precisa bater com ele. Impedir a aplicação de alterar o ledger é a parte fácil: trigger e permissão resolvem. O caso difícil é alguém com acesso de dono ao banco alterar um lançamento antigo. Trigger pode ser desligado por quem é dono da tabela, e um `UPDATE` bem feito não deixa rastro óbvio.

## Decisão

Cada lançamento guarda `prev_hash` (o hash do lançamento anterior da mesma carteira) e `entry_hash = sha256(prev_hash + ":" + JSON canônico do lançamento)`. O primeiro elo parte de um hash derivado do id da carteira.

No banco, um trigger exige que o primeiro lançamento seja a sequência 1 e que sequência, saldo e `prev_hash` continuem do anterior. Na reconciliação, a cadeia inteira é recalculada.

A sequência do ledger (`ledger_sequence`) é separada da versão da carteira: a versão é controle de concorrência, a sequência é a posição no ledger.

## Alternativas consideradas

**Só trigger e permissão.** Protege contra a aplicação, mas não detecta alteração feita por quem tem acesso de dono.

**Partidas dobradas.** O enunciado lista como diferencial opcional. Resolve outro problema (contrapartida de cada movimento entre contas) e não detecta adulteração. Com uma carteira por jogador e a casa fora do modelo, o ganho não pagava a complexidade.

## Consequências

- A reconciliação devolve `chainValid` e `firstBrokenSequence`: diz se o ledger foi alterado e a partir de qual lançamento.
- O custo é um SHA-256 por lançamento. Como a escrita já é serializada por carteira, encadear não cria contenção nova.
- O cursor de paginação do ledger usa a sequência, que é estável por construção.
- A reconciliação recalcula a cadeia inteira da carteira. Com muitos lançamentos, isso fica caro. A evolução natural seria guardar checkpoints já conferidos.
