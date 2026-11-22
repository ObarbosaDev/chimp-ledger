import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { RequireScopes } from '../../../auth/decorators';
import { Scope } from '../../../auth/principal';
import { moneyBody } from '../../../shared/infrastructure/http/contracts';
import { ZodBody } from '../../../shared/infrastructure/http/zod-body';
import { GetWallet, OpenWallet, type WalletView } from '../../application/open-wallet';

const openWalletBody = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: moneyBody,
  })
  .strict();

type OpenWalletBody = z.infer<typeof openWalletBody>;

// @Inject explícito em vez de confiar no metadata de tipo do construtor:
// fica claro o que é injetado e não depende de como o runtime emite metadata.
@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireScopes(Scope.WalletWrite)
  open(@Body(new ZodBody(openWalletBody)) body: OpenWalletBody): Promise<WalletView> {
    return this.openWallet.execute(body);
  }

  @Get(':walletId')
  @RequireScopes(Scope.WalletRead)
  get(@Param('walletId', new ParseUUIDPipe()) walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }
}
