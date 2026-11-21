import { createSqsClient, queueNamesFrom } from '../src/messaging/infrastructure/sqs-client';
import { ensureQueues } from '../src/messaging/infrastructure/sqs-topology';
import { loadConfig } from '../src/shared/infrastructure/config';

// Cria as filas FIFO (transações, DLQ e eventos) no SQS configurado.
// Pode rodar quantas vezes quiser: CreateQueue com os mesmos atributos é idempotente.
const config = loadConfig();
const sqs = createSqsClient(config);
const urls = await ensureQueues(sqs, queueNamesFrom(config));
sqs.destroy();
console.info('Filas prontas:', urls);
