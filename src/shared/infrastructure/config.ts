import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

// Tudo que a aplicação lê do ambiente passa por aqui, uma vez, no boot.
// Se faltar algo obrigatório o processo nem sobe — prefiro falhar no deploy
// do que descobrir em produção que a fila estava apontando para o lugar errado.
const schema = z.object({
  DATABASE_URL: z.string().url(),
  MIGRATOR_DATABASE_URL: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  // Espera por referência fora de ordem (ver ReferenceRetryPolicy).
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  REFERENCE_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
  REFERENCE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  REFERENCE_RETRY_TTL_MS: z.coerce.number().int().positive().default(3_600_000),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_TRANSACTIONS_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wager-events.fifo'),

  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  HTTP_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(16 * 1024),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  AUTH_ENABLED: bool.default('false'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuração inválida:\n- ${problems.join('\n- ')}`);
  }
  return parsed.data;
}
