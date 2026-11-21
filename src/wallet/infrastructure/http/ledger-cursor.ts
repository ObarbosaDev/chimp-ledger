import { z } from 'zod';
import { InvalidCursorError } from '../../application/errors';

// O cursor é opaco para o cliente: ele só devolve o que recebeu. Por dentro é
// a última sequência lida, com versão, para eu poder mudar o formato depois
// sem quebrar quem guardou um cursor antigo.
const cursorContent = z.object({ v: z.literal(1), after: z.number().int().min(0) }).strict();

export function encodeLedgerCursor(afterSequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, after: afterSequence })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    return cursorContent.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).after;
  } catch {
    throw new InvalidCursorError('Cursor inválido');
  }
}
