import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Lança WalletAlreadyExistsError se já houver carteira para jogador + moeda. */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Lê a carteira travando a linha (SELECT ... FOR UPDATE) até o fim da
   * transação. É o único jeito certo de ler antes de debitar ou creditar.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** Grava saldo, versão e head do ledger. Confere a versão anterior por segurança. */
  saveMovement(wallet: Wallet, previousVersion: number): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}
