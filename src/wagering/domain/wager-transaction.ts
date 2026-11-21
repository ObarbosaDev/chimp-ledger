import { DomainError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}

/** Transição proibida = bug no nosso código, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  /** Rastreio da requisição de origem. Não faz parte do conteúdo de negócio. */
  correlationId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const REVERSALS = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

// Provedor e campos internos usados pela OPENING, que não vem de provedor nenhum.
const INTERNAL_PROVIDER = 'internal';

/**
 * Uma operação de aposta e o seu ciclo de vida.
 *
 * Transições válidas:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PENDING_REFERENCE (reagenda) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED são finais.
 *
 * `processedAt` marca quando a transação ficou final (em qualquer dos três)
 * e `resultBalance` guarda o saldo naquele instante — é isso que o replay
 * devolve, e não o saldo de agora.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida o que dá para validar sem olhar o banco. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  /**
   * A OPENING é a única transação que o sistema cria sozinho: ela justifica
   * no ledger o saldo inicial da carteira. Já nasce processada porque é
   * gravada na mesma transação SQL que abre a carteira.
   */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
  }): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: INTERNAL_PROVIDER,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${INTERNAL_PROVIDER}:opening:${props.walletId}`,
      payloadHash: '',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: INTERNAL_PROVIDER,
      gameId: INTERNAL_PROVIDER,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
      resultBalance: props.money,
      referenceAttempts: 0,
    });
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.correlationId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.referenceAttempts,
      s.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  markProcessed(input: {
    referenceTransactionId: string | undefined;
    at: Date;
    resultBalance: Money;
  }): void {
    this.assertNotTerminal('PROCESSED');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = input.referenceTransactionId;
    this.finish(input.at, input.resultBalance);
  }

  /** Estaciona esperando a referência; cada chamada conta uma tentativa. */
  markPendingReference(nextCheckAt: Date): void {
    this.assertNotTerminal('PENDING_REFERENCE');
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = nextCheckAt;
  }

  reject(input: { code: FailureCode; at: Date; resultBalance: Money }): void {
    this.assertNotTerminal('REJECTED');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = input.code;
    this.finish(input.at, input.resultBalance);
  }

  fail(input: { code: FailureCode; at: Date }): void {
    this.assertNotTerminal('FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = input.code;
    this._processedAt = input.at;
    this._nextReferenceCheckAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSALS.has(this.kind);
  }

  isReversal(): boolean {
    return REVERSALS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Para onde o dinheiro anda. ROLLBACK depende de quem ele desfaz, por isso
   * precisa da referência já resolvida.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK precisa da referência para ter direção');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS não movimenta saldo');
    }
  }

  private finish(at: Date, resultBalance: Money): void {
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceCheckAt = undefined;
  }

  private assertNotTerminal(target: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Transação ${this.id} já está ${this._status}, não pode ir para ${target}`,
      );
    }
  }

  private static validate(p: CreateWagerTransactionProps): void {
    const required = {
      id: p.id,
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (!value?.trim()) {
        throw new InvalidWagerTransactionError(`Campo obrigatório vazio: ${field}`);
      }
    }
    if (p.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING é interna e não entra por API ou fila');
    }
    const hasReference = Boolean(p.referenceExternalTransactionId?.trim());
    if (REVERSALS.has(p.kind) && !hasReference) {
      throw new InvalidWagerTransactionError(`${p.kind} precisa de referenceExternalTransactionId`);
    }
    if (p.kind === WagerTransactionKind.Bet && hasReference) {
      throw new InvalidWagerTransactionError('BET não referencia outra transação');
    }
    // LOSS só registra o resultado, então zero faz sentido. Para todo o resto,
    // um movimento de zero não tem significado e só polui o ledger.
    if (p.kind !== WagerTransactionKind.Loss && !p.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${p.kind} precisa de valor maior que zero`);
    }
  }
}
