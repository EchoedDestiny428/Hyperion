import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile } from './percentile.ts';

test('percentiles of 1..100 are the values themselves', () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // order doesn't matter
  assert.equal(percentile(samples, 50), 50);
  assert.equal(percentile(samples, 95), 95);
  assert.equal(percentile(samples, 99), 99);
  assert.equal(percentile(samples, 100), 100);
  assert.equal(percentile(samples, 0), 1);
});

test('a single sample is every percentile', () => {
  for (const p of [0, 50, 99, 100]) assert.equal(percentile([7], p), 7);
});

test('no samples gives NaN, and the input is left unsorted', () => {
  assert.ok(Number.isNaN(percentile([], 50)));
  const samples = [3, 1, 2];
  percentile(samples, 50);
  assert.deepEqual(samples, [3, 1, 2]);
});
