// The value that `p` percent of the samples are at or below (the
// nearest-rank method). p50 is the median, a typical frame; p99 is how slow
// the slowest 1% of frames get, which is what you feel as stutter.
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1] ?? Number.NaN;
}
