import { Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from '../bootstrap/core.module';
import type { Clock, IdGenerator } from '../shared/application/ports';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import { GetWallet, OpenWallet } from './application/open-wallet';
import { WalletController } from './infrastructure/http/wallet.controller';

@Module({
  controllers: [WalletController],
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
  ],
})
export class WalletModule {}
