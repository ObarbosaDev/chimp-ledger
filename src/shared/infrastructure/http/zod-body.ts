import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Valida o corpo com zod. Os schemas usam `.strict()`, então campo que eu não
 * conheço é recusado em vez de ignorado — se o provedor mandou algo que eu
 * não entendo, prefiro avisar a fingir que está tudo bem.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
