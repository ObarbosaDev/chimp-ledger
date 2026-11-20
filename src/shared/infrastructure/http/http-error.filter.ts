import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { toHttpError } from './error-response';

/**
 * Tudo que escapa de um controller cai aqui e sai no mesmo formato
 * `{ code, message, retryable }`. Erro de validação, de domínio e de infra
 * passam pelo mesmo mapa (error-response.ts).
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof ZodError) {
      const detail = exception.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      reply.status(400).send({ code: 'INVALID_PAYLOAD', message: detail, retryable: false });
      return;
    }

    // Erros que o próprio Nest/Fastify gera (JSON quebrado, uuid inválido no
    // path, corpo grande demais...). Todos são problema do pedido.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      reply.status(status).send({
        code:
          status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status < 500
              ? 'INVALID_PAYLOAD'
              : 'INTERNAL_ERROR',
        message: exception.message,
        retryable: false,
      });
      return;
    }

    const { status, body, headers } = toHttpError(exception);
    if (headers) reply.headers(headers);
    reply.status(status).send(body);
  }
}
