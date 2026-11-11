import { test } from 'node:test';
import assert from 'node:assert/strict';
import { change, errorCells } from './compare.ts';

test('half the error is as clean as four times the samples', () => {
  assert.equal(change(4, 2), '-50.0%, 4.00× the samples');
  assert.equal(change(2, 3), '+50.0%, 0.44× the samples');
});

test('a row shows each error after the first as a change from it', () => {
  assert.deepEqual(errorCells([4, 2]), ['4.00', '2.00 (-50.0%, 4.00× the samples)']);
});
