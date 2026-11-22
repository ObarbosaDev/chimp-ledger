import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AppLogger } from '../shared/infrastructure/observability/logger';
import type { AppMetrics } from '../shared/infrastructure/observability/metrics';
import { type AuthenticatedRequest, PUBLIC_ROUTE, REQUIRED_SCOPES } from './decorators';
import type { IdentityProvider } from './identity-provider';
import { ForbiddenError, UnauthenticatedError } from './principal';

interface HttpRequest extends AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
}

// O esquema de autenticação não diferencia maiúsculas (RFC 7235): "bearer" também vale.
const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/i;

/**
 * Guard global: toda rota exige token, salvo as marcadas com @Public.
 * Fechado por padrão de propósito: uma rota nova que alguém esqueça de
 * anotar fica protegida, não exposta.
 */
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityProvider | undefined,
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;
    // Autenticação desligada (ambiente local): sem provedor de identidade, passa.
    if (!this.identity) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    try {
      const principal = await this.identity.authenticate(bearerToken(request));
      const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, targets) ?? [];
      if (!principal.hasScopes(required)) throw new ForbiddenError(required);
      request.principal = principal;
      return true;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  private recordFailure(error: unknown): void {
    const reason =
      error instanceof UnauthenticatedError
        ? error.reason
        : error instanceof ForbiddenError
          ? 'insufficient_scope'
          : 'identity_provider_unavailable';
    this.metrics.authFailures.inc({ reason });
    // Só o motivo. O token nunca vai para o log.
    this.logger.warn({ event: 'auth.rejected', reason });
  }
}

function bearerToken(request: HttpRequest): string {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? BEARER.exec(header.trim()) : null;
  if (!match?.[1]) {
    throw new UnauthenticatedError('Envie um bearer token em Authorization', 'missing_token');
  }
  return match[1];
}
