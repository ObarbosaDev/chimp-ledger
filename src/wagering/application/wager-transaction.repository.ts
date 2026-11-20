import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
}
