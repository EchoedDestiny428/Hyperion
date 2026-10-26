import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Vec3, dot, length } from '../math/vec3.ts';
import {
  type Orbit,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  applyDrag,
  applyZoom,
  orbitBasis,
} from './orbit.ts';

const EPS = 1e-9;
const near = (a: number, b: number): boolean => Math.abs(a - b) < EPS;
const nearVec = (a: Vec3, b: Vec3): boolean => a.every((x, i) => near(x, b[i] ?? NaN));

const base: Orbit = { target: [0, 1, 0], yaw: 0, pitch: 0.3, distance: 10 };

test('yaw 0, pitch 0 looks down -z with +x to the right and +y up', () => {
  const b = orbitBasis({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5 });
  assert.ok(nearVec(b.position, [0, 0, 5]));
  assert.ok(nearVec(b.forward, [0, 0, -1]));
  assert.ok(nearVec(b.right, [1, 0, 0]));
  assert.ok(nearVec(b.up, [0, 1, 0]));
});

test('the basis is orthonormal and the camera sits `distance` from the target', () => {
  for (const yaw of [0, 1, 2.5, -3]) {
    const o = { ...base, yaw };
    const b = orbitBasis(o);
    for (const v of [b.forward, b.right, b.up]) assert.ok(near(length(v), 1));
    assert.ok(near(dot(b.forward, b.right), 0));
    assert.ok(near(dot(b.forward, b.up), 0));
    assert.ok(near(dot(b.right, b.up), 0));
    const d: Vec3 = [b.position[0] - o.target[0], b.position[1] - o.target[1], b.position[2] - o.target[2]];
    assert.ok(near(length(d), o.distance));
  }
});

test('dragging clamps pitch so the camera stays above the ground', () => {
  assert.equal(applyDrag(base, 0, -100000).pitch, MIN_PITCH);
  assert.equal(applyDrag(base, 0, 100000).pitch, MAX_PITCH);
});

test('zoom is clamped and zooming in then out returns to the start', () => {
  assert.equal(applyZoom(base, -1e6).distance, MIN_DISTANCE);
  assert.equal(applyZoom(base, 1e6).distance, MAX_DISTANCE);
  assert.ok(near(applyZoom(applyZoom(base, 120), -120).distance, base.distance));
});
