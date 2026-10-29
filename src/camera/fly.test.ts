import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Fly,
  type FlyInput,
  MAX_SPEED,
  MIN_HEIGHT,
  MIN_SPEED,
  SPEED_STEP,
  changeFlySpeed,
  dollyFly,
  flyBasis,
  flyFromOrbit,
  lookFly,
  moveFly,
  orbitFromFly,
} from './fly.ts';
import { type Orbit, orbitBasis } from './orbit.ts';

const close = (a: readonly number[], b: readonly number[], message?: string): void => {
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs((a[i] ?? 0) - (b[i] ?? 0)) < 1e-9, message ?? `${a} vs ${b}`);
};

const orbit: Orbit = { target: [1, 0.5, -2], yaw: 0.7, pitch: 0.4, distance: 6 };
const still: FlyInput = { forward: 0, right: 0, up: 0, fast: false };

test('switching from orbit to fly keeps the view exactly', () => {
  const a = orbitBasis(orbit);
  const b = flyBasis(flyFromOrbit(orbit, 2));
  close(b.position, a.position);
  close(b.forward, a.forward);
  close(b.right, a.right);
  close(b.up, a.up);
});

test('switching back to orbit keeps the view too', () => {
  const back = orbitFromFly(flyFromOrbit(orbit, 2), orbit.distance);
  close(back.target, orbit.target);
  close([back.yaw, back.pitch, back.distance], [orbit.yaw, orbit.pitch, orbit.distance]);
});

test('W moves along the look direction, by speed × time', () => {
  const fly = flyFromOrbit(orbit, 2);
  const moved = moveFly(fly, { ...still, forward: 1 }, 0.5);
  const step = moved.position.map((x, i) => x - (fly.position[i] ?? 0));
  close(step, flyBasis(fly).forward.map((x) => x * 1)); // 2 m/s × 0.5 s = 1 m
});

test('diagonal movement is not faster, and Shift is', () => {
  const fly: Fly = { position: [0, 5, 0], yaw: 0, pitch: 0, speed: 1 };
  const diagonal = moveFly(fly, { ...still, forward: 1, right: 1 }, 1);
  assert.ok(Math.abs(Math.hypot(diagonal.position[0], diagonal.position[2]) - 1) < 1e-9);
  const fast = moveFly(fly, { ...still, forward: 1, fast: true }, 1);
  assert.ok(Math.abs(fast.position[2] + 4) < 1e-9);
});

test('E and Q move straight up and down, but never below the ground', () => {
  const fly: Fly = { position: [0, 1, 0], yaw: 0.3, pitch: -0.8, speed: 1 };
  close(moveFly(fly, { ...still, up: 1 }, 1).position, [0, 2, 0]);
  assert.equal(moveFly(fly, { ...still, up: -1 }, 5).position[1], MIN_HEIGHT);
});

test('looking can go straight up and past it, and the view stays well-formed', () => {
  const fly: Fly = { position: [0, 1, 0], yaw: 0.4, pitch: 0, speed: 1 };
  for (const dy of [-393, -600, -1000, 500]) {
    const b = flyBasis(lookFly(fly, 0, dy)); // 393 px ≈ straight up at 0.004 rad/px
    const dot = (u: readonly number[], v: readonly number[]): number => u.reduce((s, x, i) => s + x * (v[i] ?? 0), 0);
    for (const v of [b.forward, b.right, b.up]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
    assert.ok(Math.abs(dot(b.forward, b.up)) < 1e-9 && Math.abs(dot(b.forward, b.right)) < 1e-9);
  }
  assert.ok(flyBasis(lookFly(fly, 0, -600)).up[1] < 0); // past straight up: upside down
  assert.ok(lookFly(fly, 100, 0).yaw < fly.yaw); // dragging right turns right
});

test('[ and ] change speed in steps, within limits', () => {
  const fly: Fly = { position: [0, 1, 0], yaw: 0, pitch: 0, speed: 2 };
  assert.equal(changeFlySpeed(fly, 1).speed, 2 * SPEED_STEP);
  assert.equal(changeFlySpeed(fly, -1).speed, 2 / SPEED_STEP);
  assert.equal(changeFlySpeed(fly, 100).speed, MAX_SPEED);
  assert.equal(changeFlySpeed(fly, -100).speed, MIN_SPEED);
});

test('scrolling up zooms in: it moves the camera forward, by more at higher speed', () => {
  const fly: Fly = { position: [0, 1, 0], yaw: 0, pitch: 0, speed: 2 };
  close(dollyFly(fly, -100).position, [0, 1, -0.5]); // facing -z; 2 m/s × 0.25
  close(dollyFly({ ...fly, speed: 4 }, 100).position, [0, 1, 1]);
});
