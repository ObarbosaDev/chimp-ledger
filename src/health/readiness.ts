import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export interface Readiness {
  ready: boolean;
  checks: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
}

const CHECK_TIMEOUT_MS = 2_000;

/**
 * Prontidão = consigo atender agora: Postgres responde e a fila existe.
 * Vivacidade (live) é outra pergunta e não depende de nada externo; se ela
 * dependesse, o orquestrador reiniciaria o processo por causa do banco fora.
 */
export async function checkReadiness(
  orm: MikroORM,
  sqs: SQSClient,
  queueName: string,
): Promise<Readiness> {
  const [postgres, queue] = await Promise.all([
    probe(() => orm.em.getConnection().execute('select 1')),
    probe(() => sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))),
  ]);
  return { ready: postgres && queue, checks: { postgres: up(postgres), sqs: up(queue) } };
}

async function probe(check: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const up = (ok: boolean) => (ok ? 'up' : 'down');
