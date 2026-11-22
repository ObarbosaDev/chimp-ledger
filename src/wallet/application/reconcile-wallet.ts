import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { verifyLedgerChain } from '../domain/ledger-chain';
import { LedgerDirection } from '../domain/ledger-direction';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletNotFoundError } from './errors';
import type { LedgerRepository } from './wallet.repository';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** Saldo guardado menos o saldo calculado pelo ledger. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  chainValid: boolean;
  firstBrokenSequence: number | null;
}

/** Para onde vai o aviso de divergência (log estruturado e métrica). */
export interface ReconciliationAlarm {
  divergence(report: ReconciliationReport): void;
}

const PAGE_SIZE = 500;

/**
 * Confere uma carteira contra o próprio ledger, sem corrigir nada.
 *
 * Consistente quer dizer três coisas ao mesmo tempo:
 * - o saldo guardado é igual à soma dos lançamentos;
 * - a quantidade de lançamentos é a que a carteira registra;
 * - a corrente de hash está íntegra do primeiro ao último elo.
 *
 * Se alguma falhar, a resposta diz qual e o alarme é disparado. Corrigir
 * automaticamente esconderia justamente o problema que precisa ser investigado.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly alarm: ReconciliationAlarm,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    // Snapshot: saldo e ledger lidos no mesmo instante. Sem isso, uma aposta
    // que comitasse entre as duas leituras viraria uma divergência falsa.
    const report = await this.uow.run(
      async (tx) => {
        const wallet = await tx.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(`Carteira ${walletId} não encontrada`);

        const entries = await readWholeLedger(tx.ledger, walletId);
        const calculated = entries.reduce(
          (sum, e) =>
            e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money),
          Money.zero(wallet.currency),
        );
        const difference = wallet.balance.subtract(calculated);
        const chain = verifyLedgerChain(walletId, entries);
        const countMatches = entries.length === wallet.ledgerSequence;

        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent: difference.isZero() && chain.valid && countMatches,
          checkedEntries: entries.length,
          chainValid: chain.valid,
          firstBrokenSequence: chain.valid ? null : chain.firstBrokenSequence,
        };
      },
      { snapshot: true },
    );

    if (!report.consistent) this.alarm.divergence(report);
    return report;
  }
}

/** Lê o ledger inteiro em páginas, para não carregar uma carteira enorme de uma vez no banco. */
async function readWholeLedger(
  ledger: LedgerRepository,
  walletId: string,
): Promise<WalletLedgerEntry[]> {
  const entries: WalletLedgerEntry[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await ledger.listByWallet(walletId, afterSequence, PAGE_SIZE);
    entries.push(...page);
    if (page.length < PAGE_SIZE) return entries;
    afterSequence = page.at(-1)?.sequence ?? afterSequence;
  }
}
