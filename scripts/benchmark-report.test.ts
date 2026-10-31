import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Report, compareRounds, formatReport, median, readHud } from './benchmark-report.ts';

const hud = [
  'Hyperion · C1 in progress · Path tracer',
  'GPU      intel · gen-12lp',
  'Canvas   1280×800',
  'Frame    6.06 ms (165 fps, capped by refresh rate)',
  'GPU time p50 3.44 · p95 3.63 · p99 3.70 ms (last 120 frames drawn)',
  'Samples  512 / 1024 (refining)',
  'Camera   Orbit',
].join('\n');

test('reads the GPU, canvas, sample count and timing from the HUD', () => {
  assert.deepEqual(readHud(hud), {
    gpu: 'intel · gen-12lp',
    canvas: '1280×800',
    samples: 512,
    timing: { p50: 3.44, p95: 3.63, p99: 3.7 },
  });
});

test('timing is null until it has been measured, and other text is not a HUD', () => {
  assert.equal(readHud(hud.replace(/GPU time .*/, 'GPU time measuring…'))?.timing, null);
  assert.equal(readHud('Hyperion needs JavaScript and WebGPU to run.'), null);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('rounds are compared pair by pair, so a slow round affects both sides equally', () => {
  // The GPU halves its speed in the last two rounds, yet "after" is always 20% quicker.
  const change = compareRounds([10, 10, 10, 20, 20], [8, 8, 8, 16, 16]);
  assert.ok(Math.abs(change.ratio - 0.8) < 1e-12);
  assert.equal(change.clear, true);
});

test('a change is only clear if every round agrees on its direction', () => {
  assert.equal(compareRounds([10, 10, 10], [9, 9, 11]).clear, false);
  assert.equal(compareRounds([10, 10, 10], [11, 12, 11]).clear, true);
});

const report: Report = {
  gpu: 'intel',
  canvas: '1280×800',
  power: 'on battery',
  rounds: 2,
  results: [{ scene: 'ball-test-1', renderer: 'path', after: [4, 6], before: [], p99: [7, 7] }],
};

test('a plain table shows the median times and what they were measured on', () => {
  const text = formatReport(report);
  assert.match(text, /intel, 1280×800, on battery, 2 round\(s\)/);
  assert.match(text, /\| ball-test-1 \| path \| 5\.00 \| 7\.00 \|/);
  assert.doesNotMatch(text, /Change/);
});

test('a comparison shows before, after and the change, and flags unclear ones', () => {
  const pair = { scene: 'ball-test-1', renderer: 'path', p99: [] };
  const clear = formatReport({ ...report, results: [{ ...pair, before: [5, 5], after: [4, 4] }] });
  assert.match(clear, /\| 5\.00 \| 4\.00 \| -20\.0% \|/);
  const unclear = formatReport({ ...report, results: [{ ...pair, before: [5, 5], after: [4, 6] }] });
  assert.match(unclear, /\(not clear\)/);
});
