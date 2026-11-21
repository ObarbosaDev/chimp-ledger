import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../application/errors';
import type { LedgerRepository, WalletRepository } from '../../application/wallet.repository';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { ledgerEntryToRecord, walletFromRecord, walletToRecord } from './wallet.mapper';
import { LedgerEntrySchema, WalletSchema } from './wallet.schemas';

/**
 * Escritas aqui são explícitas (insert/nativeUpdate na hora), e não pelo
 * flush do Unit of Work. Motivo: carteira, transação e lançamento têm FK
 * entre si e um trigger que confere tudo no commit; prefiro controlar a
 * ordem dos comandos a depender de como o ORM ordena o flush.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, walletToRecord(wallet));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(
          `Jogador ${wallet.playerId} já tem carteira em ${wallet.currency}`,
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { disableIdentityMap: true });
    return record ? walletFromRecord(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // refresh garante que a leitura vai mesmo ao banco (com o lock), mesmo
    // que a carteira já esteja no identity map desta transação.
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? walletFromRecord(record) : undefined;
  }

  async saveMovement(wallet: Wallet, previousVersion: number): Promise<void> {
    const { balance, version, ledgerSequence, ledgerHeadHash, updatedAt } = walletToRecord(wallet);
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: previousVersion },
      { balance, version, ledgerSequence, ledgerHeadHash, updatedAt },
    );
    // Com a linha travada isso nunca deveria acontecer. Se acontecer, é bug
    // de concorrência e eu prefiro estourar a gravar por cima.
    if (affected !== 1) {
      throw new Error(`Carteira ${wallet.id} mudou de versão por baixo do lock`);
    }
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
  }
}
