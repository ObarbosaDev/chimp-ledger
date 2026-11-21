import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { IdGenerator } from '../../shared/application/ports';
import type { TransactionScope } from '../../shared/application/unit-of-work';
import type { MoneyProps } from '../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { InsufficientFundsError, type Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { FailureCode } from '../domain/failure-code';
import { evaluateReference } from '../domain/reference-policy';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** De onde veio o processamento, para correlacionar os eventos gerados. */
export interface EventOrigin {
  correlationId: string;
  causationId: string;
}

export interface ProcessOptions {
  /** A espera pela referência já acabou: se ela ainda não existir, rejeita. */
  referenceWaitExhausted?: boolean;
}

/**
 * A parte que decide e aplica uma transação. Fica separada porque tem dois
 * chamadores — a submissão (HTTP/fila) e o worker de referências pendentes —
 * e as regras precisam ser exatamente as mesmas nos dois.
 *
 * Pré-condição: a carteira já está travada (FOR UPDATE) pela transação SQL
 * de quem chama, e a transação de aposta ainda não está em estado final.
 */
export class WagerProcessor {
  constructor(
    private readonly ids: IdGenerator,
    private readonly referenceRetry: ReferenceRetryPolicy,
  ) {}

  async process(
    tx: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    origin: EventOrigin,
    at: Date,
    options: ProcessOptions = {},
  ): Promise<SubmitWagerResult> {
    const run = new Run(tx, transaction, wallet, this.eventContexts(origin, at), at);

    // A submissão já recusa provedor bloqueado antes de gravar qualquer coisa,
    // mas uma transação pendente pode esperar até uma hora. Se o provedor foi
    // desativado nesse meio-tempo, não aplico nada que venha dele.
    const provider = await tx.providers.findById(transaction.providerId);
    if (!provider?.active || !provider.currencies.includes(transaction.money.currency)) {
      return run.reject(FailureCode.ProviderNotAllowed);
    }
    if (wallet.playerId !== transaction.playerId) {
      return run.reject(FailureCode.WalletPlayerMismatch);
    }
    if (wallet.currency !== transaction.money.currency) {
      return run.reject(FailureCode.CurrencyMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId) {
      reference = await tx.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      const decision = evaluateReference(transaction, reference);
      if (decision.outcome === 'WAIT') {
        if (!options.referenceWaitExhausted) {
          return run.park(this.nextReferenceCheck(transaction, at));
        }
        // Esgotou a espera. "Nunca chegou" e "chegou mas nunca terminou" pedem
        // ações diferentes do provedor, então o código também é diferente.
        return run.reject(
          reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound,
        );
      }
      if (decision.outcome === 'REJECT') {
        return run.reject(decision.code);
      }
      // Só checo "já revertida" depois de saber que a referência é válida.
      // Como a referência é da mesma carteira, o lock que eu seguro já
      // impede outra reversão concorrente; o índice único é a rede de baixo.
      if (
        transaction.isReversal() &&
        reference &&
        (await tx.transactions.hasProcessedReversal(reference.id))
      ) {
        return run.reject(FailureCode.AlreadyReversed);
      }
    }

    return this.apply(run, reference);
  }

  private async apply(
    run: Run,
    reference: WagerTransaction | undefined,
  ): Promise<SubmitWagerResult> {
    const { transaction, wallet, at } = run;
    let entry: WalletLedgerEntry | undefined;

    if (transaction.affectsBalance()) {
      const movement = {
        entryId: this.ids.next(),
        transactionId: transaction.id,
        money: transaction.money,
        at,
      };
      const previousVersion = wallet.version;
      try {
        entry =
          transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        // Aposta sem saldo é rotina; reversão que deixaria o saldo negativo
        // (ex.: ROLLBACK de um WIN que o jogador já apostou) é outra história
        // e precisa de olho humano. Por isso códigos diferentes.
        return run.reject(
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.NegativeBalancePrevented,
        );
      }
      await run.tx.wallets.saveMovement(wallet, previousVersion);
      await run.tx.ledger.append(entry);
    }

    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      at,
      resultBalance: wallet.balance,
    });
    await run.tx.transactions.update(transaction);

    const events: IntegrationEvent<unknown>[] = [
      WagerTransactionProcessed.from(transaction, run.events()),
    ];
    if (entry) events.push(WalletBalanceChanged.from(wallet, entry, run.events()));
    await run.publish(events);

    return resultOf(transaction, wallet, false);
  }

  private nextReferenceCheck(transaction: WagerTransaction, at: Date): Date {
    const attempt = transaction.referenceAttempts + 1;
    return new Date(at.getTime() + this.referenceRetry.delayFor(attempt));
  }

  private eventContexts(origin: EventOrigin, at: Date): () => EventContext {
    return () => ({
      eventId: this.ids.next(),
      correlationId: origin.correlationId,
      causationId: origin.causationId,
      occurredAt: at,
    });
  }
}

/**
 * O saldo da resposta é o daquele momento (`resultBalance`). Só quando a
 * transação ainda não terminou (pendente de referência) eu uso o saldo atual.
 */
export function resultOf(
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

/** Estado de um processamento em andamento e os desfechos que não aplicam saldo. */
class Run {
  constructor(
    readonly tx: TransactionScope,
    readonly transaction: WagerTransaction,
    readonly wallet: Wallet,
    readonly events: () => EventContext,
    readonly at: Date,
  ) {}

  async reject(code: FailureCode): Promise<SubmitWagerResult> {
    this.transaction.reject({ code, at: this.at, resultBalance: this.wallet.balance });
    await this.tx.transactions.update(this.transaction);
    await this.publish([WagerTransactionRejected.from(this.transaction, this.events())]);
    return resultOf(this.transaction, this.wallet, false);
  }

  /**
   * Referência ainda não chegou: estaciona e o worker tenta de novo depois.
   * O evento sai só na primeira vez; reagendar não é novidade para ninguém.
   */
  async park(nextCheckAt: Date): Promise<SubmitWagerResult> {
    const firstTime = this.transaction.status !== WagerTransactionStatus.PendingReference;
    this.transaction.markPendingReference(nextCheckAt);
    await this.tx.transactions.update(this.transaction);
    if (firstTime) {
      await this.publish([WagerTransactionPendingReference.from(this.transaction, this.events())]);
    }
    return resultOf(this.transaction, this.wallet, false);
  }

  publish(events: IntegrationEvent<unknown>[]): Promise<void> {
    return this.tx.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  }
}
