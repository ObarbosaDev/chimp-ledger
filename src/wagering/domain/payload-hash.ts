import { canonicalJson, sha256Hex } from '../../shared/domain/canonical-json';
import type { MoneyProps } from '../../shared/domain/money';

/** Só o que tem significado de negócio. Header e metadados de transporte ficam de fora. */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * sha256 em hex do JSON canônico (chaves ordenadas) dos campos de negócio.
 * É o que separa um replay legítimo (mesmo hash) de um conflito (mesma
 * chave de idempotência com conteúdo diferente).
 */
export function computePayloadHash(fields: WagerBusinessFields): string {
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.money.amount, currency: fields.money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}
