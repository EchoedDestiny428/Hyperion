import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, cross, dot, length, normalize, scale, sub } from './vec3.ts';

test('add, sub and scale work component-wise', () => {
  assert.deepEqual(add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  assert.deepEqual(sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
  assert.deepEqual(scale([1, -2, 3], 2), [2, -4, 6]);
});

test('dot of perpendicular vectors is 0, of parallel unit vectors is 1', () => {
  assert.equal(dot([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(dot([0, 0, 1], [0, 0, 1]), 1);
});

test('cross follows the right-hand rule', () => {
  assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.deepEqual(cross([0, 1, 0], [1, 0, 0]), [0, 0, -1]);
});

test('normalize produces unit length and rejects zero vectors', () => {
  const n = normalize([3, 4, 0]);
  assert.ok(Math.abs(length(n) - 1) < 1e-12);
  // Compare with a tolerance: 3 * (1/5) is 0.6000000000000001 in floating point.
  const expected = [0.6, 0.8, 0];
  n.forEach((x, i) => assert.ok(Math.abs(x - (expected[i] ?? NaN)) < 1e-12));
  assert.throws(() => normalize([0, 0, 0]));
});
