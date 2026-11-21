import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from 'jose';
import type { IdentityProvider } from './identity-provider';
import { IdentityProviderUnavailableError, Principal, UnauthenticatedError } from './principal';

export interface JwtIdentityProviderOptions {
  /** URL do emissor, ex.: http://localhost:8081/realms/chimp */
  issuer: string;
  /** Audiência que o token precisa ter: é o nome desta API no provedor de identidade. */
  audience: string;
  /** Claim com o id do provedor de jogos. */
  providerIdClaim?: string;
}

// Só RS256. Fixar o algoritmo impede o ataque clássico de trocar para "none"
// ou para HS256 usando a chave pública como segredo.
const ALLOWED_ALGORITHMS = ['RS256'];
// Folga para relógios levemente diferentes entre Keycloak e API. Pequena de
// propósito: um token expirado não pode ganhar sobrevida.
const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Adaptador OIDC genérico: valida o JWT com as chaves públicas publicadas
 * pelo emissor (JWKS). Funciona com Keycloak e com qualquer emissor OIDC.
 *
 * A JWKS fica em cache e é buscada de novo quando aparece um `kid` que não
 * está no cache, então a rotação de chave no Keycloak não exige reiniciar
 * a API.
 */
export class JwtIdentityProvider implements IdentityProvider {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly providerIdClaim: string;

  constructor(private readonly options: JwtIdentityProviderOptions) {
    // O `iss` do token vem sem barra no final. Normalizo uma vez e uso o
    // mesmo valor para a JWKS e para a validação, senão uma barra a mais na
    // configuração recusaria todos os tokens.
    this.issuer = options.issuer.replace(/\/+$/, '');
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/protocol/openid-connect/certs`), {
      timeoutDuration: 3_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    this.providerIdClaim = options.providerIdClaim ?? 'provider_id';
  }

  async authenticate(bearerToken: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearerToken, this.jwks, {
        issuer: this.issuer,
        audience: this.options.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      throw translate(error);
    }
    return toPrincipal(payload, this.providerIdClaim);
  }
}

function toPrincipal(payload: JWTPayload, providerIdClaim: string): Principal {
  const clientId = stringClaim(payload, 'azp') ?? stringClaim(payload, 'client_id');
  if (!payload.sub || !clientId) {
    throw new UnauthenticatedError('Token sem identificação do client', 'missing_client');
  }
  const scopes = new Set((stringClaim(payload, 'scope') ?? '').split(' ').filter(Boolean));
  return new Principal(payload.sub, clientId, scopes, stringClaim(payload, providerIdClaim));
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Separa "o token é ruim" (401) de "não consegui conferir agora" (503).
 * Rejeitar um token bom porque o Keycloak caiu faria o provedor achar que a
 * credencial dele está errada.
 */
function translate(error: unknown): Error {
  if (error instanceof errors.JWTExpired) {
    return new UnauthenticatedError('Token expirado', 'expired');
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return new UnauthenticatedError(`Token recusado: ${error.claim}`, `claim_${error.claim}`);
  }
  if (
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JOSENotSupported
  ) {
    return new UnauthenticatedError('Token inválido', 'invalid_token');
  }
  // Timeout da JWKS, rede, resposta inesperada do emissor.
  return new IdentityProviderUnavailableError('Provedor de identidade indisponível');
}
