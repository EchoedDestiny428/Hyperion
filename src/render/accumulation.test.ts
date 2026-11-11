import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ballTest1 } from '../scene/layouts/ball-test-1.ts';
import { type ImageInputs, type PaceState, SLOW_PACE_MS, createSampleCounter, targetSamples } from './accumulation.ts';

const inputs: ImageInputs = {
  camera: { position: [0, 1, 5], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
  verticalFovRadians: 0.9,
  width: 800,
  height: 600,
  timeSeconds: 0,
  renderer: 1,
  view: 0,
  maxBounces: 8,
  exposure: 0,
};

test('the counter keeps its total while nothing changes', () => {
  const counter = createSampleCounter();
  const indices = [0, 1, 2, 3].map(() => {
    counter.check(inputs, ballTest1);
    return counter.take();
  });
  assert.deepEqual(indices, [0, 1, 2, 3]);
  assert.equal(counter.held, 4);
});

test('any change to the inputs or the scene starts the total over', () => {
  const changes: ImageInputs[] = [
    { ...inputs, width: 801 },
    { ...inputs, timeSeconds: 0.016 },
    { ...inputs, renderer: 0 },
    { ...inputs, view: 2 },
    { ...inputs, maxBounces: 3 },
    { ...inputs, exposure: 0.5 },
  ];
  for (const changed of changes) {
    const counter = createSampleCounter();
    counter.check(inputs, ballTest1);
    counter.take();
    counter.take();
    counter.check(changed, ballTest1);
    assert.equal(counter.held, 0, JSON.stringify(changed));
  }

  const counter = createSampleCounter();
  counter.check(inputs, ballTest1);
  counter.take();
  counter.check(inputs, { ...ballTest1 }); // another scene object, even with the same contents
  assert.equal(counter.held, 0);
});

test('moving the camera keeps the total, but the still count starts again', () => {
  const counter = createSampleCounter();
  counter.check(inputs, ballTest1);
  counter.take();
  counter.take();
  assert.equal(counter.moved, false);
  counter.check({ ...inputs, camera: { ...inputs.camera, position: [0, 1, 5.01] } }, ballTest1);
  assert.equal(counter.moved, true);
  assert.equal(counter.held, 2); // the picture carries on: new random numbers, no restart
  assert.equal(counter.still, 0); // and refines again, up to the limit, after the move
  assert.equal(counter.take(), 2);
  counter.check({ ...inputs, camera: { ...inputs.camera, position: [0, 1, 5.01] } }, ballTest1);
  assert.equal(counter.moved, false);
  assert.equal(counter.still, 1);
});

test('restart empties the total', () => {
  const counter = createSampleCounter();
  counter.check(inputs, ballTest1);
  counter.take();
  counter.restart();
  assert.equal(counter.held, 0);
  assert.equal(counter.take(), 0);
});

const state = (overrides: Partial<PaceState>): PaceState => ({
  held: 5,
  limit: 16,
  pace: 'full',
  msSinceLastSample: 0,
  stepRequested: false,
  ...overrides,
});

test('the first sample after a change is always drawn', () => {
  for (const pace of ['full', 'slow', 'step'] as const) assert.equal(targetSamples(state({ held: 0, pace })), 1, pace);
});

test('full pace adds a sample every frame, up to the limit', () => {
  assert.equal(targetSamples(state({})), 6);
  assert.equal(targetSamples(state({ held: 16 })), 16);
});

test('slow pace waits between samples', () => {
  assert.equal(targetSamples(state({ pace: 'slow', msSinceLastSample: SLOW_PACE_MS - 1 })), 5);
  assert.equal(targetSamples(state({ pace: 'slow', msSinceLastSample: SLOW_PACE_MS })), 6);
});

test('step pace adds a sample only when asked, up to the limit', () => {
  assert.equal(targetSamples(state({ pace: 'step' })), 5);
  assert.equal(targetSamples(state({ pace: 'step', stepRequested: true })), 6);
  assert.equal(targetSamples(state({ pace: 'step', stepRequested: true, held: 16 })), 16);
});
