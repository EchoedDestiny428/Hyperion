// The pure half of the benchmark: reading the HUD's text and turning repeated
// measurements into a table. benchmark.ts is the half that drives a browser.

export interface Timing {
  p50: number; // milliseconds of GPU time per sample
  p95: number;
  p99: number;
}

export interface HudReading {
  gpu: string;
  canvas: string; // such as "1280×800"
  samples: number; // in the image so far
  timing: Timing | null; // null until the first measurements arrive
}

// The HUD is what a person sees, so measuring from it means the benchmark
// reports the same numbers. Null if the text isn't a HUD.
export function readHud(text: string): HudReading | null {
  const lines = text.split('\n');
  const value = (label: string): string | undefined =>
    lines.find((line) => line.startsWith(`${label} `))?.slice(label.length).trim();

  const gpu = value('GPU     '); // the extra spaces tell it apart from "GPU time"
  const canvas = value('Canvas');
  const samples = value('Samples')?.match(/^\d+/)?.[0];
  if (gpu === undefined || canvas === undefined || samples === undefined) return null;

  const time = value('GPU time')?.match(/p50 ([\d.]+) · p95 ([\d.]+) · p99 ([\d.]+) ms/);
  const timing = time ? { p50: Number(time[1]), p95: Number(time[2]), p99: Number(time[3]) } : null;
  return { gpu, canvas, samples: Number(samples), timing };
}

// One scene and renderer: the p50 of each round. `before` stays empty unless
// another build is being compared against.
export interface Result {
  scene: string;
  renderer: string;
  after: number[];
  before: number[];
  p99: number[];
}

export interface Report {
  gpu: string;
  canvas: string;
  power: string; // battery lowers GPU speed, so note what a table was measured on
  rounds: number;
  results: Result[];
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? Number.NaN) + upper) / 2;
}

export interface Change {
  ratio: number; // after ÷ before: 0.8 means 20% less time
  clear: boolean; // every round moved the same way
}

// Compares round by round, since each pair was measured moments apart under
// the same conditions. A change only counts as clear if every round agrees
// on its direction; with 5 rounds, chance alone does that about 1 time in 16.
export function compareRounds(before: readonly number[], after: readonly number[]): Change {
  const ratios = after.map((value, i) => value / (before[i] ?? Number.NaN));
  return { ratio: median(ratios), clear: ratios.every((r) => r < 1) || ratios.every((r) => r > 1) };
}

const ms = (value: number): string => value.toFixed(2);

function changeText({ ratio, clear }: Change): string {
  const percent = (ratio - 1) * 100;
  const text = `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
  return clear ? text : `${text} (not clear)`;
}

// A Markdown table, with before and change columns when comparing.
export function formatReport(report: Report): string {
  const comparing = report.results.some((result) => result.before.length > 0);
  const header = comparing
    ? ['Scene', 'Renderer', 'Before ms', 'After ms', 'Change']
    : ['Scene', 'Renderer', 'p50 ms', 'p99 ms'];

  const rows = report.results.map(({ scene, renderer, before, after, p99 }) =>
    comparing
      ? [scene, renderer, ms(median(before)), ms(median(after)), changeText(compareRounds(before, after))]
      : [scene, renderer, ms(median(after)), ms(median(p99))],
  );

  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const table = [line(header), line(header.map(() => '---')), ...rows.map(line)];
  return [`${report.gpu}, ${report.canvas}, ${report.power}, ${report.rounds} round(s)`, '', ...table].join('\n');
}
