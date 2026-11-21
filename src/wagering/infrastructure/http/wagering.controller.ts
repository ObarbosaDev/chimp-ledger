import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentPrincipal, RequireScopes } from '../../../auth/decorators';
import { type Principal, ProviderMismatchError, Scope } from '../../../auth/principal';
import { ID_GENERATOR } from '../../../bootstrap/core.module';
import type { IdGenerator } from '../../../shared/application/ports';
import { ZodBody } from '../../../shared/infrastructure/http/zod-body';
import { TransactionNotFoundError } from '../../application/errors';
import { GetTransaction, type TransactionView } from '../../application/get-transaction';
import {
  type SubmitWagerResult,
  SubmitWagerTransaction,
} from '../../application/submit-wager-transaction';
import { idempotencyKeyHeader, type WagerOperation, wagerOperation } from '../wager-contract';

// Status por resultado. Rejeição de negócio volta como 422 com o corpo do
// resultado (status + failureCode), não como corpo de erro: a transação
// existe, foi gravada e pode ser consultada depois.
function statusFor(result: SubmitWagerResult): number {
  switch (result.status) {
    case 'PROCESSED':
      return result.idempotentReplay ? 200 : 201;
    case 'PENDING_REFERENCE':
    case 'PENDING':
      return 202;
    case 'REJECTED':
      return 422;
    default:
      return 500;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(GetTransaction) private readonly getTransaction: GetTransaction,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  @RequireScopes(Scope.WagerWrite)
  async create(
    @Body(new ZodBody(wagerOperation)) body: WagerOperation,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @CurrentPrincipal() principal: Principal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SubmitWagerResult> {
    // Quem é o provedor quem diz é o token, não o corpo. Um provedor com
    // credencial vazada ainda assim só consegue mexer no que é dele.
    principal?.assertActsAs(body.providerId);
    const idempotencyKey = idempotencyKeyHeader.parse(rawKey);
    const result = await this.submit.execute(
      { ...body, idempotencyKey },
      { correlationId: correlationId ?? this.ids.next() },
    );
    reply.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @RequireScopes(Scope.WalletRead)
  async byId(
    @Param('transactionId', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal | undefined,
  ): Promise<TransactionView> {
    const view = await this.getTransaction.byId(id);
    // Transação de outro provedor responde como inexistente: 403 aqui
    // confirmaria que aquele id existe.
    if (principal && !principal.canSee(view.providerId)) {
      throw new TransactionNotFoundError(`Transação ${id} não encontrada`);
    }
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @RequireScopes(Scope.WalletRead)
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @CurrentPrincipal() principal: Principal | undefined,
  ): Promise<TransactionView> {
    if (principal && !principal.canSee(providerId)) {
      throw new ProviderMismatchError(`Sem acesso às transações do provedor ${providerId}`);
    }
    return this.getTransaction.byExternalId(providerId, externalId);
  }
}
