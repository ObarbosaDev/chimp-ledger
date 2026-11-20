import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WagerTransactionSchema } from '../../../wagering/infrastructure/persistence/wager-transaction.schema';
import {
  LedgerEntrySchema,
  WalletSchema,
} from '../../../wallet/infrastructure/persistence/wallet.schemas';
import type { AppConfig } from '../config';

export const ENTITY_SCHEMAS = [WalletSchema, LedgerEntrySchema, WagerTransactionSchema];

export async function createOrm(config: AppConfig): Promise<MikroORM> {
  return MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: config.DATABASE_URL,
    entities: ENTITY_SCHEMAS,
    pool: { min: 0, max: config.DB_POOL_MAX },
    // O esquema é responsabilidade das migrações escritas à mão; aqui o ORM
    // só lê e grava. Contexto global desligado obriga a usar fork por operação.
    allowGlobalContext: false,
    debug: false,
  });
}
