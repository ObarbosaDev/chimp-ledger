import { FailureCode } from './failure-code';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export type ReferenceDecision =
  | { outcome: 'OK' }
  | { outcome: 'WAIT' }
  | { outcome: 'REJECT'; code: FailureCode };

// Quem pode apontar para quem. REFUND só desfaz aposta; ROLLBACK desfaz
// qualquer coisa que mexeu no saldo, menos outro ROLLBACK (desfazer o
// desfazer viraria uma corrente difícil de auditar).
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Decide se a referência de uma transação serve. Não consulta banco: quem
 * chama já buscou a referência por (providerId, referenceExternalTransactionId).
 * A regra "reverter só uma vez" fica fora daqui porque depende de outras
 * transações — ela é garantida por índice único no banco.
 */
export function evaluateReference(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
): ReferenceDecision {
  // Referência que ainda não chegou ou ainda não terminou: espero. Se eu
  // rejeitasse aqui, uma simples troca de ordem na fila virava erro.
  if (!reference || !reference.isTerminal()) {
    return { outcome: 'WAIT' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(FailureCode.ReferenceNotProcessed);
  }
  if (!ALLOWED_REFERENCES[transaction.kind]?.includes(reference.kind)) {
    return reject(FailureCode.InvalidReferenceKind);
  }
  const sameContext =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId;
  if (!sameContext) {
    return reject(FailureCode.ReferenceMismatch);
  }
  if (reference.money.currency !== transaction.money.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }
  if (transaction.isReversal() && !reference.money.equals(transaction.money)) {
    return reject(FailureCode.AmountMismatch);
  }
  return { outcome: 'OK' };
}

function reject(code: FailureCode): ReferenceDecision {
  return { outcome: 'REJECT', code };
}
