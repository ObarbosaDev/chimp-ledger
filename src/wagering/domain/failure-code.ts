/**
 * Códigos estáveis que vão na resposta e nos eventos. O provedor decide o
 * que fazer olhando só para o código — nunca para a mensagem. Por isso cada
 * um tem uma ação recomendada:
 *
 * - RETRY: pode reenviar igual, o problema é nosso e passageiro;
 * - FIX_PAYLOAD: o pedido está errado, reenviar igual vai falhar de novo;
 * - GIVE_UP: decisão final de negócio, não adianta insistir.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  NegativeBalancePrevented = 'NEGATIVE_BALANCE_PREVENTED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ProviderNotAllowed = 'PROVIDER_NOT_ALLOWED',
  InfrastructurePermanent = 'INFRASTRUCTURE_PERMANENT',
}

export type FailureAction = 'RETRY' | 'FIX_PAYLOAD' | 'GIVE_UP';

export const FAILURE_CODE_META: Record<FailureCode, { action: FailureAction; meaning: string }> = {
  [FailureCode.InsufficientFunds]: {
    action: 'GIVE_UP',
    meaning: 'Aposta maior que o saldo do jogador.',
  },
  [FailureCode.NegativeBalancePrevented]: {
    action: 'GIVE_UP',
    meaning: 'Reversão deixaria o saldo negativo (ex.: ROLLBACK de WIN já gasto). Pede análise.',
  },
  [FailureCode.ReferenceNotFound]: {
    action: 'FIX_PAYLOAD',
    meaning: 'A transação referenciada não apareceu dentro do prazo de espera.',
  },
  [FailureCode.ReferenceNotProcessed]: {
    action: 'GIVE_UP',
    meaning: 'A referência existe, mas foi rejeitada ou falhou — não há o que reverter.',
  },
  [FailureCode.ReferenceMismatch]: {
    action: 'FIX_PAYLOAD',
    meaning: 'Referência de outro provedor, jogador, carteira ou rodada.',
  },
  [FailureCode.InvalidReferenceKind]: {
    action: 'FIX_PAYLOAD',
    meaning: 'Tipo de referência não permitido (ex.: REFUND de WIN).',
  },
  [FailureCode.AlreadyReversed]: {
    action: 'GIVE_UP',
    meaning: 'A referência já foi revertida antes.',
  },
  [FailureCode.AmountMismatch]: {
    action: 'FIX_PAYLOAD',
    meaning: 'Valor da reversão diferente do valor da referência.',
  },
  [FailureCode.CurrencyMismatch]: {
    action: 'FIX_PAYLOAD',
    meaning: 'Moeda diferente da carteira ou da referência.',
  },
  [FailureCode.WalletNotFound]: {
    action: 'FIX_PAYLOAD',
    meaning: 'Carteira informada não existe.',
  },
  [FailureCode.WalletPlayerMismatch]: {
    action: 'FIX_PAYLOAD',
    meaning: 'A carteira não pertence ao jogador informado.',
  },
  [FailureCode.ProviderNotAllowed]: {
    action: 'GIVE_UP',
    meaning: 'Provedor desconhecido, inativo ou sem permissão para a moeda.',
  },
  [FailureCode.InfrastructurePermanent]: {
    action: 'GIVE_UP',
    meaning:
      'Falha de infraestrutura que não vai se resolver sozinha. Fica registrada para auditoria.',
  },
};
