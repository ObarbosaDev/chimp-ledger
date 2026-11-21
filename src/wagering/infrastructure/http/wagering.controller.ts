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
import { ID_GENERATOR } from '../../../bootstrap/core.module';
import type { IdGenerator } from '../../../shared/application/ports';
import { ZodBody } from '../../../shared/infrastructure/http/zod-body';
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
  async create(
    @Body(new ZodBody(wagerOperation)) body: WagerOperation,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SubmitWagerResult> {
    const idempotencyKey = idempotencyKeyHeader.parse(rawKey);
    const result = await this.submit.execute(
      { ...body, idempotencyKey },
      { correlationId: correlationId ?? this.ids.next() },
    );
    reply.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ParseUUIDPipe()) id: string): Promise<TransactionView> {
    return this.getTransaction.byId(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ): Promise<TransactionView> {
    return this.getTransaction.byExternalId(providerId, externalId);
  }
}
