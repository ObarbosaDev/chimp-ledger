import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.0';

export interface TestKeycloak {
  issuer: string;
  token(clientId: string, secret: string): Promise<string>;
  stop(): Promise<void>;
}

/** Keycloak de verdade com o mesmo realm versionado em docker/keycloak/realm.json. */
export async function startKeycloak(): Promise<TestKeycloak> {
  const container: StartedTestContainer = await new GenericContainer(KEYCLOAK_IMAGE)
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      KC_HEALTH_ENABLED: 'true',
    })
    .withCopyFilesToContainer([
      { source: 'docker/keycloak/realm.json', target: '/opt/keycloak/data/import/realm.json' },
    ])
    .withExposedPorts(8080)
    .withWaitStrategy(
      Wait.forHttp('/realms/chimp/.well-known/openid-configuration', 8080).forStatusCode(200),
    )
    .withStartupTimeout(180_000)
    .start();

  const issuer = `http://${container.getHost()}:${container.getMappedPort(8080)}/realms/chimp`;

  return {
    issuer,
    async token(clientId, secret) {
      const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: secret,
        }),
      });
      if (!res.ok) throw new Error(`Keycloak recusou o client ${clientId}: ${res.status}`);
      return ((await res.json()) as { access_token: string }).access_token;
    },
    stop: () => container.stop().then(() => undefined),
  };
}
