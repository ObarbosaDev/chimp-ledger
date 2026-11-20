import { z } from 'zod';

// Formato de dinheiro no contrato HTTP. A validação fina (duas casas, sem
// notação científica) é do Money; aqui só garanto que chegou string.
export const moneyBody = z
  .object({
    amount: z.string(),
    currency: z.string(),
  })
  .strict();
