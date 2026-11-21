import { createWorker } from './bootstrap/worker';
import { loadConfig } from './shared/infrastructure/config';

const worker = await createWorker(loadConfig());
worker.start();

// SIGTERM é o "por favor, saia" do Docker/Kubernetes. Termino o que está em
// andamento antes de sair; se eu morresse na hora, o que estivesse no meio
// voltaria pela fila ou pelo lease, mas sair limpo evita trabalho repetido.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await worker.stop();
    process.exit(0);
  });
}
