import { Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from '../bootstrap/core.module';
import type { Clock, IdGenerator } from '../shared/application/ports';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import { ListLedger } from './application/list-ledger';
import { GetWallet, OpenWallet } from './application/open-wallet';
import { ReconcileWallet, type ReconciliationAlarm } from './application/reconcile-wallet';
import { LedgerController } from './infrastructure/http/ledger.controller';
import { WalletController } from './infrastructure/http/wallet.controller';
import { LoggingReconciliationAlarm } from './infrastructure/reconciliation-alarm';

export const RECONCILIATION_ALARM = Symbol('ReconciliationAlarm');

@Module({
  controllers: [WalletController, LedgerController],
  providers: [
    {
      provide: OpenWallet,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new OpenWallet(uow, ids, clock),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWallet(uow),
    },
    {
      provide: ListLedger,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ListLedger(uow),
    },
    { provide: RECONCILIATION_ALARM, useFactory: () => new LoggingReconciliationAlarm() },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, RECONCILIATION_ALARM],
      useFactory: (uow: UnitOfWork, alarm: ReconciliationAlarm) => new ReconcileWallet(uow, alarm),
    },
  ],
})
export class WalletModule {}
