import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import type { SubmitWagerTransaction } from '../../wagering/application/submit-wager-transaction';
import { idempotencyKeyHeader, wagerOperation } from '../../wagering/infrastructure/wager-contract';
import { classifyFailure, type FailureKind } from './failure-classifier';
import type { QueueUrls } from './sqs-topology';

export interface WagerConsumerOptions {
  consumerName: string;
  /** Long polling: quanto tempo o receive espera por mensagem (máx. 20). */
  waitTimeSeconds: number;
  /** Base do backoff de reentrega em falha transitória: base · 2^(entregas−1). */
  retryBaseSeconds: number;
  maxMessages?: number;
}

const MAX_VISIBILITY_SECONDS = 300;

const envelope = z
  .object({
    messageId: z.string().min(1).max(256),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime(),
    data: wagerOperation.extend({ idempotencyKey: idempotencyKeyHeader }),
  })
  .strict();

export type MessageOutcome = 'acked' | 'dead-lettered' | 'retry-later' | 'released';

/**
 * Consome a fila de transações e chama o MESMO caso de uso do HTTP.
 *
 * Garantias:
 * - ack (delete) só depois que a transação SQL comitou;
 * - a inbox dentro da transação faz a reentrega da mesma messageId virar replay;
 * - mensagens da mesma carteira (MessageGroupId) são processadas em ordem,
 *   carteiras diferentes em paralelo;
 * - em stop(): espera o receive atual voltar (no máximo waitTimeSeconds),
 *   termina o que já começou e devolve na hora (visibilidade 0) o que ainda
 *   não começou. Não aborto o receive: o cancelamento é só do lado do
 *   cliente, e o servidor ainda entregaria mensagens para ninguém.
 */
export class WagerConsumer {
  private stopping = false;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: Pick<QueueUrls, 'transactions' | 'transactionsDlq'>,
    private readonly submit: SubmitWagerTransaction,
    private readonly options: WagerConsumerOptions,
    private readonly onOutcome?: (outcome: MessageOutcome, failure?: FailureKind) => void,
  ) {}

  /** Uma rodada de receive. Devolve quantas mensagens foram tratadas. */
  async pollOnce(): Promise<number> {
    if (this.stopping) return 0;
    const messages = await this.receive();
    if (messages.length === 0) return 0;

    const byGroup = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? 'sem-grupo';
      byGroup.set(group, [...(byGroup.get(group) ?? []), m]);
    }
    await Promise.all(
      [...byGroup.values()].map(async (group) => {
        for (const m of group) await this.handle(m);
      }),
    );
    return messages.length;
  }

  /** Pede para parar; quem espera o fim da rodada é o PollingLoop. */
  stop(): void {
    this.stopping = true;
  }

  private async receive(): Promise<Message[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queues.transactions,
        MaxNumberOfMessages: this.options.maxMessages ?? 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    return Messages;
  }

  private async handle(message: Message): Promise<void> {
    if (this.stopping) {
      await this.setVisibility(message, 0);
      return this.report('released');
    }

    try {
      const { messageId, data } = envelope.parse(JSON.parse(message.Body ?? ''));
      const { idempotencyKey, ...operation } = data;
      await this.submit.execute(
        { ...operation, idempotencyKey },
        {
          correlationId: messageId,
          inbox: { consumerName: this.options.consumerName, messageId },
        },
      );
      await this.delete(message);
      this.report('acked');
    } catch (error) {
      const kind = classifyFailure(error);
      if (kind === 'business') {
        await this.delete(message);
        this.report('acked', kind);
      } else if (kind === 'permanent') {
        await this.deadLetter(message, error);
        this.report('dead-lettered', kind);
      } else {
        const deliveries = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
        const delay = Math.min(
          this.options.retryBaseSeconds * 2 ** (deliveries - 1),
          MAX_VISIBILITY_SECONDS,
        );
        await this.setVisibility(message, delay);
        this.report('retry-later', kind);
      }
    }
  }

  // Mensagem que nunca vai dar certo não precisa esperar 5 entregas: mando
  // para a DLQ na hora, com o motivo, e só depois apago da fila principal.
  private async deadLetter(message: Message, error: unknown): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.transactionsDlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'sem-grupo',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: {
            DataType: 'String',
            StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 256),
          },
        },
      }),
    );
    await this.delete(message);
  }

  private delete(message: Message): Promise<unknown> {
    return this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queues.transactions,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private setVisibility(message: Message, seconds: number): Promise<unknown> {
    return this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queues.transactions,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private report(outcome: MessageOutcome, failure?: FailureKind): void {
    this.onOutcome?.(outcome, failure);
  }
}
