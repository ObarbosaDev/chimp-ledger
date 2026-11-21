import { createServer } from 'node:net';
import type { Subprocess } from 'bun';
import type { TestStack } from '../support/test-stack';

export interface Instance {
  url: string;
  process: Subprocess;
}

export interface Fleet {
  instances: Instance[];
  stop(): Promise<void>;
}

/**
 * Sobe N processos da API de verdade (bun src/main.api.ts), cada um na sua
 * porta, todos apontando para o mesmo Postgres. É o mais perto que dá de
 * "várias instâncias atrás de um load balancer" sem sair da máquina.
 */
export async function startFleet(stack: TestStack, size: number): Promise<Fleet> {
  const instances: Instance[] = [];
  for (let i = 0; i < size; i++) {
    const port = await freePort();
    const child = Bun.spawn(['bun', 'src/main.api.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: stack.appUrl,
        SQS_ENDPOINT: stack.sqsEndpoint,
        HTTP_PORT: String(port),
        LOG_LEVEL: 'silent',
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    instances.push({ url: `http://127.0.0.1:${port}`, process: child });
  }
  await Promise.all(instances.map((i) => waitUntilReady(i.url)));

  return {
    instances,
    async stop() {
      for (const i of instances) i.process.kill();
      await Promise.all(instances.map((i) => i.process.exited));
    },
  };
}

async function waitUntilReady(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Qualquer resposta HTTP serve: significa que o processo subiu e já
      // conversou com o banco (404 de carteira inexistente).
      const res = await fetch(`${url}/wallets/00000000-0000-7000-8000-000000000000`);
      if (res.status === 404) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  throw new Error(`Instância ${url} não subiu em ${timeoutMs}ms`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
