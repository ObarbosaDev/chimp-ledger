import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { Clock, IdGenerator } from '../../shared/application/ports';
import type { TransactionScope, UnitOfWork } from '../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { WalletNotFoundError } from '../../wallet/application/errors';
import type { Wallet } from '../../wallet/domain/wallet';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import { IdempotencyConflictError, ProviderNotAllowedError } from './errors';
import { resultOf, type SubmitWagerResult, type WagerProcessor } from './wager-processor';

export type { SubmitWagerResult } from './wager-processor';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<`${WagerTransactionKind}`, 'OPENING'>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitContext {
  correlationId: string;
  /** Presente quando a operação veio da fila: vira o registro na inbox. */
  inbox?: { consumerName: string; messageId: string };
}

/**
 * A única porta de entrada para mexer em dinheiro por aposta. HTTP e SQS
 * chamam este mesmo caso de uso, então as regras não têm como divergir.
 *
 * Tudo acontece numa transação SQL só, nesta ordem:
 *   1. inbox (se veio da fila) — reentrega da mesma mensagem não faz nada;
 *   2. trava a carteira (SELECT ... FOR UPDATE) — serializa a carteira;
 *   3. reserva a chave de idempotência — replay ou conflito param aqui;
 *   4. o WagerProcessor confere contexto e referência e aplica.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly processor: WagerProcessor,
  ) {}

  async execute(command: SubmitWagerCommand, context: SubmitContext): Promise<SubmitWagerResult> {
    const at = this.clock.now();
    const payloadHash = computePayloadHash(command);

    // Validação que não depende do banco acontece antes de abrir transação:
    // pedido malformado nem chega a pegar lock.
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: at,
    });

    return this.uow.run(async (tx) => {
      await this.assertProviderAllowed(tx, candidate);

      if (context.inbox) {
        const firstDelivery = await tx.inbox.record(
          InboxMessage.receive({ ...context.inbox, payloadHash, receivedAt: at }),
        );
        if (!firstDelivery) {
          return this.replayDuplicateMessage(tx, candidate);
        }
      }

      const wallet = await tx.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`Carteira ${candidate.walletId} não encontrada`);
      }

      const reserved = await tx.transactions.insertIfAbsent(candidate);
      if (!reserved) {
        return this.resolveExisting(tx, candidate, wallet);
      }

      const origin = {
        correlationId: context.correlationId,
        causationId: context.inbox?.messageId ?? candidate.idempotencyKey,
      };
      return this.processor.process(tx, candidate, wallet, origin, at);
    });
  }

  /**
   * A chave já estava reservada. Mesmo conteúdo = replay, devolvo o resultado
   * guardado. Conteúdo diferente, ou mesmo id externo com outra chave, é
   * conflito: o provedor está reaproveitando identificador e isso não pode
   * virar efeito silencioso.
   */
  private async resolveExisting(
    tx: TransactionScope,
    candidate: WagerTransaction,
    wallet: Wallet,
  ): Promise<SubmitWagerResult> {
    const sameKey = await tx.transactions.findByIdempotencyKey(
      candidate.providerId,
      candidate.idempotencyKey,
    );
    if (sameKey?.matchesPayload(candidate.payloadHash)) {
      return resultOf(sameKey, wallet, true);
    }
    throw new IdempotencyConflictError(
      sameKey
        ? `Chave ${candidate.idempotencyKey} já usada com outro conteúdo`
        : `Transação externa ${candidate.externalTransactionId} já registrada com outra chave`,
    );
  }

  /** A mesma mensagem da fila chegou de novo. O efeito já foi comitado antes. */
  private async replayDuplicateMessage(
    tx: TransactionScope,
    candidate: WagerTransaction,
  ): Promise<SubmitWagerResult> {
    const existing = await tx.transactions.findByIdempotencyKey(
      candidate.providerId,
      candidate.idempotencyKey,
    );
    const wallet = await tx.wallets.findById(candidate.walletId);
    if (!existing || !wallet) {
      throw new IdempotencyConflictError(
        `Mensagem repetida sem transação correspondente (${candidate.idempotencyKey})`,
      );
    }
    return resultOf(existing, wallet, true);
  }

  private async assertProviderAllowed(
    tx: TransactionScope,
    transaction: WagerTransaction,
  ): Promise<void> {
    const provider = await tx.providers.findById(transaction.providerId);
    const allowed =
      provider?.active === true && provider.currencies.includes(transaction.money.currency);
    if (!allowed) {
      throw new ProviderNotAllowedError(
        `Provedor ${transaction.providerId} não pode operar em ${transaction.money.currency}`,
      );
    }
  }
}
