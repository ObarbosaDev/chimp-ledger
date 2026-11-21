import { DomainError } from '../shared/domain/errors';

/** Escopos que as rotas exigem. Ficam num lugar só para não virar string solta. */
export const Scope = {
  WagerWrite: 'wager:write',
  WalletRead: 'wallet:read',
  WalletWrite: 'wallet:write',
  WalletReconcile: 'wallet:reconcile',
  /** Ledger completo da carteira: mostra atividade de todos os provedores. */
  LedgerRead: 'ledger:read',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

/**
 * Quem está chamando, já verificado. `providerId` existe só para os clients
 * de provedor de jogos; o backoffice não tem, e por isso nunca consegue
 * enviar aposta em nome de alguém.
 */
export class Principal {
  constructor(
    readonly subject: string,
    readonly clientId: string,
    readonly scopes: ReadonlySet<string>,
    readonly providerId?: string,
  ) {}

  hasScopes(required: readonly string[]): boolean {
    return required.every((scope) => this.scopes.has(scope));
  }

  /** O provedor do token precisa ser o mesmo que aparece no pedido. */
  assertActsAs(providerId: string): void {
    if (this.providerId !== providerId) {
      throw new ProviderMismatchError(
        `Token do client ${this.clientId} não pode agir como o provedor ${providerId}`,
      );
    }
  }
}

/** Sem token, token inválido, expirado ou de outro emissor/audiência. */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';

  constructor(
    message: string,
    /** Motivo curto para métrica e log; nunca vai na resposta. */
    readonly reason: string,
  ) {
    super(message);
  }
}

/** Token válido, mas sem o escopo que a rota exige. */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';

  constructor(readonly requiredScopes: readonly string[]) {
    super(`Escopo insuficiente: a rota exige ${requiredScopes.join(' ')}`);
  }
}

export class ProviderMismatchError extends DomainError {
  readonly code = 'PROVIDER_MISMATCH';
}

/** O provedor de identidade não respondeu: não é culpa de quem chamou. */
export class IdentityProviderUnavailableError extends Error {
  readonly code = 'IDENTITY_PROVIDER_UNAVAILABLE';
}
