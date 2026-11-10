import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstAndLast } from './timer.ts';

// Only compared by identity here, so any object will do.
const querySet = {} as GPUQuerySet;

test('firstAndLast gives the start to the first pass and the end to the last', () => {
  assert.deepEqual(firstAndLast({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }), {
    first: { querySet, beginningOfPassWriteIndex: 0 },
    last: { querySet, endOfPassWriteIndex: 1 },
  });
});

test('firstAndLast leaves out a half with nothing to write', () => {
  // A split of a split: the denoiser is handed only the end.
  assert.deepEqual(firstAndLast({ querySet, endOfPassWriteIndex: 1 }), {
    first: undefined,
    last: { querySet, endOfPassWriteIndex: 1 },
  });
  assert.deepEqual(firstAndLast(undefined), { first: undefined, last: undefined });
});
