import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApiApp } from '../../src/bootstrap/api';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { runMigrations } from '../../src/shared/infrastructure/database/migrator';
import { startTestStack, type TestStack } from './test-stack';

export interface HttpResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: corpo de resposta é inspecionado livremente no teste
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

export interface ApiHarness {
  stack: TestStack;
  app: NestFastifyApplication;
  request(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResult>;
  stop(): Promise<void>;
}

/** App HTTP real (Nest + Fastify) ligado a Postgres e LocalStack reais. */
export async function startApiHarness(): Promise<ApiHarness> {
  const stack = await startTestStack();
  await runMigrations(stack.migratorUrl, 'up');
  await stack.sql(
    `insert into providers (id, currencies) values ('provider-a', '{BRL,USD}'), ('provider-b', '{BRL}')`,
  );

  const config = loadConfig({
    DATABASE_URL: stack.appUrl,
    MIGRATOR_DATABASE_URL: stack.migratorUrl,
    SQS_ENDPOINT: stack.sqsEndpoint,
    LOG_LEVEL: 'silent',
  });
  const app = await createApiApp(config);

  return {
    stack,
    app,
    async request(method, url, body, headers = {}) {
      const res = await app.inject({
        method,
        url,
        payload: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
      });
      return {
        status: res.statusCode,
        body: res.body ? JSON.parse(res.body) : undefined,
        headers: res.headers as HttpResult['headers'],
      };
    },
    async stop() {
      await app.close();
      await stack.stop();
    },
  };
}
