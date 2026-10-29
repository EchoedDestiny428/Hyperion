import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Vec3, dot, length } from '../math/vec3.ts';
import {
  type Orbit,
  MAX_DISTANCE,
  MIN_DISTANCE,
  applyDrag,
  applyZoom,
  orbitBasis,
  spinOrbit,
  upsideDown,
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

test('the basis is orthonormal at every angle, straight up and upside down included', () => {
  for (const yaw of [0, 1, 2.5, -3]) {
    for (const pitch of [0.3, Math.PI / 2, 2, Math.PI, -Math.PI / 2, -1]) {
      const o = { ...base, yaw, pitch };
      const b = orbitBasis(o);
      for (const v of [b.forward, b.right, b.up]) assert.ok(near(length(v), 1), `${yaw} ${pitch}`);
      assert.ok(near(dot(b.forward, b.right), 0));
      assert.ok(near(dot(b.forward, b.up), 0));
      assert.ok(near(dot(b.right, b.up), 0));
      const d: Vec3 = [b.position[0] - o.target[0], b.position[1] - o.target[1], b.position[2] - o.target[2]];
      assert.ok(near(length(d), o.distance));
    }
  }
});

test('the camera can go all the way over the top', () => {
  const overTop = orbitBasis({ ...base, pitch: 2 }); // past straight up (π/2 ≈ 1.57)
  assert.ok(overTop.position[1] > base.target[1]); // still above the target
  assert.ok(overTop.up[1] < 0); // and upside down
  assert.ok(upsideDown(2) && !upsideDown(0.3));
  // Pitch wraps around instead of stopping or growing forever.
  const lapped = applyDrag(base, 0, 10_000).pitch;
  assert.ok(lapped >= -Math.PI && lapped <= Math.PI);
});

test('upside down, dragging still turns the view the way the mouse goes', () => {
  const flipped = { ...base, pitch: 2 };
  assert.ok(applyDrag(flipped, 10, 0).yaw > flipped.yaw); // the opposite of right side up
  assert.ok(applyDrag(base, 10, 0).yaw < base.yaw);
});

test('the right arrow turns the scene right, like dragging right', () => {
  const before = orbitBasis(base);
  const after = orbitBasis(spinOrbit(base, { right: 1, up: 0 }, 0.1));
  const moved: Vec3 = [after.position[0] - before.position[0], 0, after.position[2] - before.position[2]];
  assert.ok(dot(moved, before.right) < 0); // so the camera circles to its left
  const spunYawDown = spinOrbit(base, { right: 1, up: 0 }, 0.1).yaw < base.yaw;
  const draggedYawDown = applyDrag(base, 10, 0).yaw < base.yaw;
  assert.equal(spunYawDown, draggedYawDown);
});

test('the up arrow tilts like dragging up', () => {
  assert.ok(spinOrbit(base, { right: 0, up: 1 }, 0.1).pitch < base.pitch);
  assert.ok(applyDrag(base, 0, -10).pitch < base.pitch); // dragging up (negative dy) does the same
  assert.equal(spinOrbit(base, { right: 0, up: 0 }, 1), base); // no keys, no change
});

test('zoom is clamped and zooming in then out returns to the start', () => {
  assert.equal(applyZoom(base, -1e6).distance, MIN_DISTANCE);
  assert.equal(applyZoom(base, 1e6).distance, MAX_DISTANCE);
  assert.ok(near(applyZoom(applyZoom(base, 120), -120).distance, base.distance));
});
