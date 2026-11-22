import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueNames {
  transactions: string;
  transactionsDlq: string;
  events: string;
}

export interface QueueUrls {
  transactions: string;
  transactionsDlq: string;
  events: string;
}

/** Quantas entregas uma mensagem tem antes de o SQS mandar ela pra DLQ. */
const MAX_RECEIVE_COUNT = 5;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;

/**
 * Cria (ou só confirma) as filas. CreateQueue no SQS é idempotente quando os
 * atributos batem, então dá para rodar isso em todo setup sem medo.
 *
 * Deduplicação por conteúdo fica desligada de propósito: quem manda define o
 * MessageDeduplicationId. E mesmo assim isso é só otimização: quem garante
 * que nada é aplicado duas vezes é a inbox no banco.
 */
export async function ensureQueues(
  sqs: SQSClient,
  names: QueueNames,
  { visibilityTimeoutSeconds = DEFAULT_VISIBILITY_TIMEOUT_SECONDS } = {},
): Promise<QueueUrls> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const transactionsDlq = await createQueue(sqs, names.transactionsDlq, fifo);
  const dlqArn = await queueArn(sqs, transactionsDlq);

  const transactions = await createQueue(sqs, names.transactions, {
    ...fifo,
    VisibilityTimeout: String(visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  });

  const events = await createQueue(sqs, names.events, fifo);

  return { transactions, transactionsDlq, events };
}

async function createQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  if (!QueueUrl) throw new Error(`SQS não devolveu URL para a fila ${name}`);
  return QueueUrl;
}

async function queueArn(sqs: SQSClient, url: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error(`Não consegui o ARN da fila ${url}`);
  return arn;
}
