import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';

export interface InboxRepository {
  /**
   * Registra a mensagem como processada. Devolve false se ela já tinha sido
   * registrada antes, ou seja, é uma reentrega e o efeito já existe.
   */
  record(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
}
