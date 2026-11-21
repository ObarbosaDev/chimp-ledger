import type { Principal } from './principal';

/**
 * Porta para o provedor de identidade. A aplicação só sabe que recebe um
 * bearer token e devolve um Principal; se é Keycloak, Zitadel ou Cognito é
 * detalhe do adaptador.
 *
 * Contrato:
 * - token inválido de qualquer forma → UnauthenticatedError;
 * - provedor de identidade inalcançável → IdentityProviderUnavailableError
 *   (vira 503: a culpa não é de quem chamou).
 */
export interface IdentityProvider {
  authenticate(bearerToken: string): Promise<Principal>;
}
