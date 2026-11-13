import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCameraPath, spinYaw, sunSeconds, walkPosition } from './path.ts';

test('no path options, no path', () => {
  assert.deepEqual(parseCameraPath('?scene=dreamspace'), { path: null, problems: [] });
});

test('reads a spin: spin, frames and turn', () => {
  assert.deepEqual(parseCameraPath('?spin=0.5&frames=60&turn=-15'), {
    path: { kind: 'spin', step: 0.5, frames: 60, start: -15 },
    problems: [],
  });
  assert.deepEqual(parseCameraPath('?spin=2').path, { kind: 'spin', step: 2, frames: Infinity, start: 0 });
  assert.deepEqual(parseCameraPath('?turn=30').path, { kind: 'spin', step: 0, frames: Infinity, start: 30 });
});

test('reads a walk: walk, frames and ahead', () => {
  assert.deepEqual(parseCameraPath('?walk=0.02&frames=60&ahead=0.5').path, {
    kind: 'walk',
    step: 0.02,
    frames: 60,
    start: 0.5,
  });
  assert.deepEqual(parseCameraPath('?ahead=1.2').path, { kind: 'walk', step: 0, frames: Infinity, start: 1.2 });
});

test('values that make no sense are ignored, with a reason', () => {
  const { path, problems } = parseCameraPath('?spin=fast&frames=2.5&turn=');
  assert.equal(path, null);
  assert.equal(problems.length, 3);
  assert.match(problems[0] ?? '', /\?spin=fast/);
  assert.equal(parseCameraPath('?frames=10').problems.length, 1); // frames without spin or walk
  const both = parseCameraPath('?spin=1&walk=0.02');
  assert.equal(both.path?.kind, 'walk');
  assert.equal(both.problems.length, 1);
});

test('frame n of a spin is the same view as a turn of n × spin', () => {
  const spin = { kind: 'spin', step: 0.5, frames: 60, start: 10 } as const;
  const turned = { kind: 'spin', step: 0, frames: Infinity, start: 10 + 60 * 0.5 } as const;
  assert.equal(spinYaw(0.3, spin, 60), spinYaw(0.3, turned, 0));
  assert.ok(Math.abs(spinYaw(0, spin, 0) - (10 * Math.PI) / 180) < 1e-12);
});

test('a walk goes straight ahead, level, and frame n matches ahead = n × walk', () => {
  const start = { position: [1, 1.6, 2] as const, yaw: 0 }; // yaw 0 looks toward -z
  const walk = { kind: 'walk', step: 0.02, frames: 60, start: 0 } as const;
  const ahead = { kind: 'walk', step: 0, frames: Infinity, start: 60 * 0.02 } as const;
  assert.deepEqual(walkPosition(start, walk, 60), walkPosition(start, ahead, 0));
  const [x, y, z] = walkPosition(start, walk, 50);
  assert.ok(Math.abs(x - 1) < 1e-12 && y === 1.6 && Math.abs(z - (2 - 1)) < 1e-12);
});

test('reads a sun path, and frame n matches sunturn = n × sun', () => {
  const path = parseCameraPath('?sun=0.5&frames=40').path;
  assert.deepEqual(path, { kind: 'sun', step: 0.5, frames: 40, start: 0 });
  const turned = parseCameraPath('?sunturn=20').path;
  assert.deepEqual(turned, { kind: 'sun', step: 0, frames: Infinity, start: 20 });
  assert.ok(path && turned);
  assert.equal(sunSeconds(path, 40), sunSeconds(turned, 0));
  assert.equal(parseCameraPath('?sun=0.5&spin=1').problems.length, 1);
});
