import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '../../../src/shared/infrastructure/polling-loop';

describe('PollingLoop', () => {
  test('roda de novo na hora quando a rodada teve trabalho, e espera quando não teve', async () => {
    const timeline: number[] = [];
    let calls = 0;
    const loop = new PollingLoop(
      'teste',
      async () => {
        timeline.push(Date.now());
        calls++;
        return calls <= 3; // 3 rodadas com trabalho, depois ocioso
      },
      { idleDelayMs: 200 },
    );

    loop.start();
    await Bun.sleep(120);
    await loop.stop();

    expect(calls).toBe(4);
    const [a, , , d] = timeline as [number, number, number, number];
    expect(d - a).toBeLessThan(100);
  });

  test('stop espera a rodada em andamento terminar', async () => {
    let finished = false;
    const loop = new PollingLoop(
      'teste',
      async () => {
        await Bun.sleep(150);
        finished = true;
        return false;
      },
      { idleDelayMs: 1_000 },
    );

    loop.start();
    await Bun.sleep(20);
    await loop.stop();
    expect(finished).toBe(true);
  });

  test('erro numa rodada não derruba o loop', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const loop = new PollingLoop(
      'teste',
      async () => {
        calls++;
        if (calls === 1) throw new Error('banco piscou');
        return calls < 3;
      },
      { idleDelayMs: 10, errorDelayMs: 10, onError: (e) => errors.push(e) },
    );

    loop.start();
    await Bun.sleep(100);
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
