/** Relógio injetável: nos testes eu controlo o tempo, em produção é o do sistema. */
export interface Clock {
  now(): Date;
}

/** Gera ids ordenáveis por tempo (UUIDv7 na implementação real). */
export interface IdGenerator {
  next(): string;
}
