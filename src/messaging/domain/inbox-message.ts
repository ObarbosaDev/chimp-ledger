import { DomainError } from '../../shared/domain/errors';

export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro de "essa mensagem já passou por aqui". A garantia de verdade é a
 * chave primária (consumer_name, message_id) no banco, gravada na mesma
 * transação do efeito financeiro: se a transação comitou, a mensagem conta
 * como processada; se não comitou, nem o efeito nem a inbox existem.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`Mensagem ${this.messageId} já foi processada`);
    }
    this._processedAt = at;
  }
}
