export interface PollingLoopOptions {
  /** Pausa depois de uma rodada sem trabalho. */
  idleDelayMs: number;
  /** Pausa depois de uma rodada que falhou (default: idleDelayMs). */
  errorDelayMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Loop de trabalho em segundo plano (relay da outbox, reprocessamento de
 * pendentes, consumidor). A rodada devolve `true` se fez alguma coisa:
 * nesse caso roda de novo na hora, porque provavelmente tem mais. Se não
 * fez nada, descansa um pouco.
 *
 * `stop()` não corta a rodada no meio: ela termina o que começou (e a
 * transação dela comita ou desfaz inteira). Só a pausa ociosa é interrompida.
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(
    readonly name: string,
    private readonly round: () => Promise<boolean>,
    private readonly options: PollingLoopOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.current;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let delay = 0;
      try {
        const didWork = await this.round();
        if (!didWork) delay = this.options.idleDelayMs;
      } catch (error) {
        this.options.onError?.(error);
        delay = this.options.errorDelayMs ?? this.options.idleDelayMs;
      }
      if (this.running && delay > 0) await this.pause(delay);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
