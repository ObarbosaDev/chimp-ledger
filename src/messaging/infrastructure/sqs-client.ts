import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../shared/infrastructure/config';
import type { QueueNames, QueueUrls } from './sqs-topology';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
  });
}

export function queueNamesFrom(config: AppConfig): QueueNames {
  return {
    transactions: config.SQS_TRANSACTIONS_QUEUE,
    transactionsDlq: config.SQS_TRANSACTIONS_DLQ,
    events: config.SQS_EVENTS_QUEUE,
  };
}

/**
 * Só descobre as URLs. Criar fila não é trabalho do worker em produção:
 * isso é infraestrutura (aqui, o `bun run setup:sqs`). Se a fila não
 * existir, o worker nem sobe, o que é melhor do que subir e ficar mudo.
 */
export async function resolveQueueUrls(sqs: SQSClient, names: QueueNames): Promise<QueueUrls> {
  const url = async (QueueName: string) => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName }));
    if (!QueueUrl) throw new Error(`Fila ${QueueName} não encontrada`);
    return QueueUrl;
  };
  const [transactions, transactionsDlq, events] = await Promise.all([
    url(names.transactions),
    url(names.transactionsDlq),
    url(names.events),
  ]);
  return { transactions, transactionsDlq, events };
}
