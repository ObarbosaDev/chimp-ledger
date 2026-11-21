import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { Clock, IdGenerator } from '../../shared/application/ports';
import type { TransactionScope, UnitOfWork } from '../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { WalletNotFoundError } from '../../wallet/application/errors';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { InsufficientFundsError, type Wallet } from '../../wallet/domain/wallet';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { FailureCode } from '../domain/failure-code';
import { computePayloadHash } from '../domain/payload-hash';
import { evaluateReference } from '../domain/reference-policy';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction';
import { IdempotencyConflictError, ProviderNotAllowedError } from './errors';

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

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/**
 * A única porta de entrada para mexer em dinheiro por aposta. HTTP e SQS
 * chamam este mesmo caso de uso, então as regras não têm como divergir.
 *
 * Tudo acontece numa transação SQL só, nesta ordem:
 *   1. inbox (se veio da fila) — reentrega da mesma mensagem não faz nada;
 *   2. trava a carteira (SELECT ... FOR UPDATE) — serializa a carteira;
 *   3. reserva a chave de idempotência — replay ou conflito param aqui;
 *   4. confere contexto e referência;
 *   5. aplica no saldo + ledger, atualiza a transação, grava os eventos.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly referenceRetry: ReferenceRetryPolicy,
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

      const events = new EventFactory(this.ids, context, candidate.idempotencyKey, at);
      return this.process(tx, candidate, wallet, events, at);
    });
  }

  private async process(
    tx: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    events: EventFactory,
    at: Date,
  ): Promise<SubmitWagerResult> {
    if (wallet.playerId !== transaction.playerId) {
      return this.reject(tx, transaction, wallet, FailureCode.WalletPlayerMismatch, events, at);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(tx, transaction, wallet, FailureCode.CurrencyMismatch, events, at);
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId) {
      reference = await tx.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      const decision = evaluateReference(transaction, reference);
      if (decision.outcome === 'WAIT') {
        return this.park(tx, transaction, wallet, events, at);
      }
      if (decision.outcome === 'REJECT') {
        return this.reject(tx, transaction, wallet, decision.code, events, at);
      }
      // Só checo "já revertida" depois de saber que a referência é válida.
      // Como a referência é da mesma carteira, o lock que eu seguro já
      // impede outra reversão concorrente; o índice único é a rede de baixo.
      if (
        transaction.isReversal() &&
        reference &&
        (await tx.transactions.hasProcessedReversal(reference.id))
      ) {
        return this.reject(tx, transaction, wallet, FailureCode.AlreadyReversed, events, at);
      }
    }

    return this.apply(tx, transaction, wallet, reference, events, at);
  }

  private async apply(
    tx: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    events: EventFactory,
    at: Date,
  ): Promise<SubmitWagerResult> {
    const outbox: IntegrationEvent<unknown>[] = [];

    if (transaction.affectsBalance()) {
      const direction = transaction.ledgerDirectionFor(reference);
      const previousVersion = wallet.version;
      const movement = {
        entryId: this.ids.next(),
        transactionId: transaction.id,
        money: transaction.money,
        at,
      };

      let entry: ReturnType<Wallet['debit']>;
      try {
        entry =
          direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        // Aposta sem saldo é rotina; reversão que deixaria o saldo negativo
        // (ex.: ROLLBACK de um WIN que o jogador já apostou) é outra história
        // e precisa de olho humano. Por isso códigos diferentes.
        const code =
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.NegativeBalancePrevented;
        return this.reject(tx, transaction, wallet, code, events, at);
      }

      await tx.wallets.saveMovement(wallet, previousVersion);
      await tx.ledger.append(entry);
      outbox.push(WalletBalanceChanged.from(wallet, entry, events.next()));
    }

    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      at,
      resultBalance: wallet.balance,
    });
    await tx.transactions.update(transaction);
    outbox.unshift(WagerTransactionProcessed.from(transaction, events.next()));
    await tx.outbox.enqueue(outbox.map((event) => OutboxMessage.enqueue(event)));

    return resultOf(transaction, wallet, false);
  }

  private async reject(
    tx: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    events: EventFactory,
    at: Date,
  ): Promise<SubmitWagerResult> {
    transaction.reject({ code, at, resultBalance: wallet.balance });
    await tx.transactions.update(transaction);
    await tx.outbox.enqueue([
      OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, events.next())),
    ]);
    return resultOf(transaction, wallet, false);
  }

  /** Referência ainda não chegou: estaciona e o worker tenta de novo depois. */
  private async park(
    tx: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    events: EventFactory,
    at: Date,
  ): Promise<SubmitWagerResult> {
    const nextAttempt = transaction.referenceAttempts + 1;
    transaction.markPendingReference(
      new Date(at.getTime() + this.referenceRetry.delayFor(nextAttempt)),
    );
    await tx.transactions.update(transaction);
    await tx.outbox.enqueue([
      OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, events.next())),
    ]);
    return resultOf(transaction, wallet, false);
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

/**
 * O saldo da resposta é o daquele momento (`resultBalance`). Só quando a
 * transação ainda não terminou (pendente de referência) eu uso o saldo atual.
 */
function resultOf(
  transaction: WagerTransaction,
  wallet: Wallet,
  idempotentReplay: boolean,
): SubmitWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: (transaction.resultBalance ?? wallet.balance).toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}

/** Monta o contexto de cada evento com id próprio e a mesma correlação. */
class EventFactory {
  constructor(
    private readonly ids: IdGenerator,
    private readonly context: SubmitContext,
    private readonly fallbackCause: string,
    private readonly at: Date,
  ) {}

  next(): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: this.context.correlationId,
      causationId: this.context.inbox?.messageId ?? this.fallbackCause,
      occurredAt: this.at,
    };
  }
}
