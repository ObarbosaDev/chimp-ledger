import { z } from 'zod';
import { moneyBody } from '../../shared/infrastructure/http/contracts';

// Identificador vindo do provedor: sem espaço nem caractere de controle.
// Isso protege log, chave de fila e URL de consulta de surpresas.
const externalId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/, 'só caracteres ASCII visíveis, sem espaço');

/**
 * Contrato de uma operação de aposta, igual para HTTP e fila. OPENING não
 * está no enum de propósito: ela só nasce dentro da abertura de carteira.
 */
export const wagerOperation = z
  .object({
    providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    externalTransactionId: externalId,
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: externalId,
    gameId: externalId,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: moneyBody,
    referenceExternalTransactionId: externalId.optional(),
  })
  .strict();

export type WagerOperation = z.infer<typeof wagerOperation>;

export const idempotencyKeyHeader = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7E]+$/);
