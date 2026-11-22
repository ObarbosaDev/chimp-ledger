# ADR 005: Mapa de status HTTP

**Status:** aceita

## Contexto

O provedor precisa decidir, só pelo status, se reenvia, corrige o pedido ou desiste. O enunciado pede que payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente e falha transitória sejam distinguíveis, e de forma consistente entre todos os endpoints.

## Decisão

| Status | Situação | O provedor deve |
|---|---|---|
| `200` | consulta, ou replay idempotente | seguir |
| `201` | criado ou processado pela primeira vez | seguir |
| `202` | aceito, aguardando a referência | consultar depois |
| `400` | payload inválido | corrigir antes de reenviar |
| `401` / `403` | sem token válido / sem permissão | corrigir a credencial |
| `404` | recurso não existe | corrigir |
| `409` | conflito de idempotência ou duplicidade | não reenviar igual |
| `422` | rejeitada por regra de negócio, com `failureCode` | não insistir |
| `503` | falha passageira nossa, com `Retry-After` | reenviar depois |

Todo erro tem o mesmo corpo: `{ code, message, retryable }`. O mapeamento fica num lugar só (`src/shared/infrastructure/http/error-response.ts`), e cada código de erro do domínio tem exatamente um status.

## Alternativas consideradas

**`200` com status no corpo para tudo que foi gravado.** A rejeição de negócio fica gravada como `REJECTED`, então daria para responder `200`. Mas o provedor teria que ler o corpo para saber se a aposta passou, e um cliente HTTP genérico trataria a recusa como sucesso.

**`400` para rejeição de negócio.** Mistura "o pedido está malformado" com "o pedido é válido e a resposta é não". As ações do provedor são diferentes.

## Consequências

- `409`, `422` e `503` nunca se misturam. O `retryable` no corpo confirma o que o status já diz.
- Uma transação rejeitada responde `422`, e o replay dela responde a mesma rejeição. A transação fica gravada e é auditável.
- Lock que não saiu a tempo e banco fora do ar respondem `503`, com `Retry-After`: são problemas nossos e passageiros.
- Keycloak fora do ar também responde `503`, não `401`. O token pode estar certo; quem não conseguiu conferir fomos nós.
- Transação de outro provedor pelo id interno responde `404`, e não `403`, para não confirmar que ela existe.
