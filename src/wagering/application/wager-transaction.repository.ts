import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  /** Usado só pela OPENING, que nunca disputa chave de idempotência. */
  insert(transaction: WagerTransaction): Promise<void>;

  /**
   * Tenta reservar a chave de idempotência gravando a transação. Devolve
   * false se já existir outra com a mesma chave ou o mesmo id externo. Se a
   * outra ainda estiver em andamento, o Postgres espera ela terminar antes
   * de responder — então quem chega depois sempre enxerga o resultado final.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;

  /** Grava as mudanças de ciclo de vida (status, saldo resultante, tentativas). */
  update(transaction: WagerTransaction): Promise<void>;

  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;

  /** Já existe REFUND ou ROLLBACK processado apontando para essa transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}

export interface ProviderInfo {
  id: string;
  active: boolean;
  currencies: string[];
}

export interface ProviderRepository {
  findById(id: string): Promise<ProviderInfo | undefined>;
}
