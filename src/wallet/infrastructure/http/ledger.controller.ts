import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { RequireScopes } from '../../../auth/decorators';
import { Scope } from '../../../auth/principal';
import { ZodBody } from '../../../shared/infrastructure/http/zod-body';
import { type LedgerEntryView, ListLedger } from '../../application/list-ledger';
import { ReconcileWallet, type ReconciliationReport } from '../../application/reconcile-wallet';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

const MAX_PAGE_SIZE = 200;

const ledgerQuery = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

type LedgerQuery = z.infer<typeof ledgerQuery>;

@Controller('wallets/:walletId')
export class LedgerController {
  constructor(
    @Inject(ListLedger) private readonly listLedger: ListLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Get('ledger')
  @RequireScopes(Scope.WalletRead)
  async ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query(new ZodBody(ledgerQuery)) query: LedgerQuery,
  ): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }> {
    const page = await this.listLedger.execute(
      walletId,
      decodeLedgerCursor(query.cursor),
      query.limit,
    );
    return {
      items: page.items,
      nextCursor:
        page.nextAfterSequence === null ? null : encodeLedgerCursor(page.nextAfterSequence),
    };
  }

  // POST porque é uma operação (recalcula e pode disparar alarme), mesmo sem
  // alterar dados. Responde 200: nada é criado.
  @Post('reconciliation')
  @RequireScopes(Scope.WalletReconcile)
  @HttpCode(200)
  reconcile(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId);
  }
}
