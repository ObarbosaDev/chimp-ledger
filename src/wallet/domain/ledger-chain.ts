import { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export type ChainVerification = { valid: true } | { valid: false; firstBrokenSequence: number };

/**
 * Confere a corrente de lançamentos de uma carteira, na ordem da sequência.
 * Cada elo precisa:
 * - ter a sequência seguinte à do anterior (começando em 1);
 * - apontar para o hash do anterior (o primeiro aponta para o gênese);
 * - começar do saldo em que o anterior terminou;
 * - ter um hash que bate com o próprio conteúdo.
 *
 * Os triggers já impedem gravar algo fora disso. Esta verificação existe para
 * o caso em que alguém passou por cima deles (trigger desligado, restore de
 * backup errado, acesso direto ao disco): ela aponta o primeiro elo quebrado.
 */
export function verifyLedgerChain(
  walletId: string,
  entries: readonly WalletLedgerEntry[],
): ChainVerification {
  let previous: WalletLedgerEntry | undefined;
  for (const [index, entry] of entries.entries()) {
    const expectedSequence = index + 1;
    const linked = previous
      ? entry.prevHash === previous.entryHash && entry.balanceBefore.equals(previous.balanceAfter)
      : entry.prevHash === Wallet.genesisHash(walletId) && entry.balanceBefore.isZero();

    if (
      entry.sequence !== expectedSequence ||
      !linked ||
      !entry.isBalanced() ||
      !entry.hasValidHash()
    ) {
      return { valid: false, firstBrokenSequence: expectedSequence };
    }
    previous = entry;
  }
  return { valid: true };
}
