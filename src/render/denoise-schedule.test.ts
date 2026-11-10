import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type FilterInputs, needsFilter } from './denoise-schedule.ts';

const image = (samples: number, more: Partial<FilterInputs> = {}): FilterInputs => ({
  generation: 1,
  samples,
  level: 2,
  finished: false,
  ...more,
});

test('a new image, or a new level, is always filtered', () => {
  assert.equal(needsFilter(null, image(1)), true);
  assert.equal(needsFilter(image(500), image(500, { generation: 2 })), true);
  assert.equal(needsFilter(image(500), image(500, { level: 3 })), true);
});

test('nothing new, no filter', () => {
  assert.equal(needsFilter(image(500), image(500)), false);
  assert.equal(needsFilter(image(1024, { finished: true }), image(1024, { finished: true })), false);
});

test('filters again once the samples grow by a tenth', () => {
  assert.equal(needsFilter(image(100), image(109)), false);
  assert.equal(needsFilter(image(100), image(110)), true);
  assert.equal(needsFilter(image(5), image(6)), true); // every sample, early on
});

test('the finished image gets a fresh filter', () => {
  assert.equal(needsFilter(image(1000), image(1024, { finished: true })), true);
});

test('refining to 1,024 samples one at a time filters about 60 times, the last at 1,024', () => {
  let last: FilterInputs | null = null;
  const filteredAt: number[] = [];
  for (let samples = 1; samples <= 1024; samples++) {
    const now = image(samples, { finished: samples === 1024 });
    if (needsFilter(last, now)) {
      filteredAt.push(samples);
      last = now;
    }
  }
  assert.ok(filteredAt.length > 50 && filteredAt.length < 70, `${filteredAt.length} filters`);
  assert.equal(filteredAt.at(-1), 1024);
  assert.deepEqual(filteredAt.slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
