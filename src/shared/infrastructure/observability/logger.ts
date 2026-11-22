import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config';

export type AppLogger = Logger;

/**
 * Logger JSON, uma linha por evento. Os campos de rastreio (correlationId,
 * messageId, transactionId, walletId, providerId) vão em cada linha de
 * negócio. Valores monetários e payloads ficam de fora: o redact remove
 * qualquer campo com esses nomes, mesmo que alguém o passe por engano.
 */
export function createLogger(config: AppConfig, destination?: DestinationStream): AppLogger {
  return pino(
    {
      level: config.LOG_LEVEL,
      base: { service: 'chimp-ledger' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: ['money', 'balance', 'amount', 'payload', '*.money', '*.balance', '*.amount'],
        remove: true,
      },
    },
    destination,
  );
}
