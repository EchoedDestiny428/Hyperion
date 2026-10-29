import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_UNIFORM_FLOATS, packFrameUniforms } from './frame-uniforms.ts';

test('fields land at the offsets struct Frame in whitted.wgsl expects', () => {
  const u = packFrameUniforms({
    camera: { position: [1, 2, 3], right: [4, 5, 6], up: [7, 8, 9], forward: [10, 11, 12] },
    verticalFovRadians: Math.PI / 2, // tan(45°) = 1
    width: 1920,
    height: 1080,
    timeSeconds: 42,
    layers: 0b101,
    view: 3,
    sampleIndex: 77,
  });
  assert.equal(u.length, FRAME_UNIFORM_FLOATS);
  assert.equal(u.byteLength % 16, 0); // uniform structs are sized in 16-byte steps
  assert.deepEqual([...u.subarray(0, 3)], [1, 2, 3]);
  assert.ok(Math.abs((u[3] ?? 0) - 1) < 1e-6);
  assert.deepEqual([...u.subarray(4, 7)], [4, 5, 6]);
  assert.ok(Math.abs((u[7] ?? 0) - 1920 / 1080) < 1e-6);
  assert.deepEqual([...u.subarray(8, 11)], [7, 8, 9]);
  assert.equal(u[11], 42);
  assert.deepEqual([...u.subarray(12, 15)], [10, 11, 12]);
  assert.deepEqual([...u.subarray(16, 18)], [1920, 1080]);

  // The integer fields must hold the integers themselves, not float bit patterns.
  const ints = new Uint32Array(u.buffer);
  assert.equal(ints[15], 0b101);
  assert.equal(ints[18], 3);
  assert.equal(ints[19], 77);
});
