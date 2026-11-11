// Shared by the measuring scripts that compare pictures (noise.ts, motion.ts).

// "−29%, 2.0× the samples": a picture with 29% less error is as clean as one
// with 2× the samples would be, since error falls with the square root of the
// sample count.
export function change(before: number, after: number): string {
  const percent = (after / before - 1) * 100;
  const samples = (before / after) ** 2;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%, ${samples.toFixed(2)}× the samples`;
}

// A markdown table row: the first error alone, the others with their change from it.
export function errorCells(errors: readonly number[]): string[] {
  const first = errors[0] ?? Number.NaN;
  return errors.map((error, i) => (i === 0 ? error.toFixed(2) : `${error.toFixed(2)} (${change(first, error)})`));
}
