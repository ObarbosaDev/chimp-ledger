export interface LatencySummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Percentil pelo método do posto mais próximo: devolve sempre um valor que
 * de fato foi medido, sem interpolar. Para latência é o mais honesto.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

export function summarize(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      mean: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
    };
  }
  // Laço em vez de Math.max(...values): com centenas de milhares de medições
  // o spread estoura a pilha.
  let total = 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    total += v;
    if (v > max) max = v;
  }
  return {
    count: values.length,
    mean: total / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max,
  };
}
