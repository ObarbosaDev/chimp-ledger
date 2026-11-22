import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Principal, Scope } from './principal';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_SCOPES = 'auth:scopes';

/** Rota aberta, sem token (health checks, métricas). Use com parcimônia. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** Escopos que o token precisa ter para chamar a rota. */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

export interface AuthenticatedRequest {
  principal?: Principal;
}

/**
 * Principal da requisição. Fica `undefined` quando a autenticação está
 * desligada (ambiente local), e as regras de provedor só se aplicam quando
 * ele existe.
 */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);
