import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type HudFrame, sampleStatus } from './hud.ts';

const frame: HudFrame = {
  renderer: 'Path tracer',
  width: 640,
  height: 400,
  samples: 1,
  sampleLimit: 1024,
  pace: 'full',
  gpuTimes: [],
  camera: 'Orbit',
  movingHistory: null,
};

test('standing still, the Samples line says how refining is going', () => {
  assert.equal(sampleStatus({ ...frame, samples: 1 }), 'hold still to refine');
  assert.equal(sampleStatus({ ...frame, samples: 300 }), 'refining');
  assert.equal(sampleStatus({ ...frame, samples: 1024 }), 'done');
});

test('moving, it says what each pixel holds', () => {
  assert.equal(sampleStatus({ ...frame, movingHistory: 4 }), 'moving: 1 new per frame, up to 5 per pixel');
  assert.equal(sampleStatus({ ...frame, movingHistory: 0 }), 'moving: 1 new per frame, none carried over');
});
