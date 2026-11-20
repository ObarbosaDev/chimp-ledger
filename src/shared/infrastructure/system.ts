import type { Clock, IdGenerator } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

// UUIDv7 começa pelo timestamp: índice b-tree cresce sempre no fim, em vez de
// espalhar inserção pela árvore inteira como um v4 faria.
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
