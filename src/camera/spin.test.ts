import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpin, spinYaw } from './spin.ts';

test('no spin options, no spin', () => {
  assert.deepEqual(parseSpin('?scene=dreamspace'), { spin: null, problems: [] });
});

test('reads spin, frames and turn', () => {
  assert.deepEqual(parseSpin('?spin=0.5&frames=60&turn=-15'), {
    spin: { degreesPerFrame: 0.5, frames: 60, turnDegrees: -15 },
    problems: [],
  });
  assert.deepEqual(parseSpin('?spin=2').spin, { degreesPerFrame: 2, frames: Infinity, turnDegrees: 0 });
  assert.deepEqual(parseSpin('?turn=30').spin, { degreesPerFrame: 0, frames: Infinity, turnDegrees: 30 });
});

test('values that make no sense are ignored, with a reason', () => {
  const { spin, problems } = parseSpin('?spin=fast&frames=2.5&turn=');
  assert.equal(spin, null);
  assert.equal(problems.length, 3);
  assert.match(problems[0] ?? '', /\?spin=fast/);
  assert.equal(parseSpin('?frames=10').problems.length, 1); // frames without spin
});

test('frame n of a spin is the same view as a turn of n × spin', () => {
  const spin = { degreesPerFrame: 0.5, frames: 60, turnDegrees: 10 };
  const turned = { degreesPerFrame: 0, frames: Infinity, turnDegrees: 10 + 60 * 0.5 };
  assert.equal(spinYaw(0.3, spin, 60), spinYaw(0.3, turned, 0));
  assert.ok(Math.abs(spinYaw(0, spin, 0) - (10 * Math.PI) / 180) < 1e-12);
});
