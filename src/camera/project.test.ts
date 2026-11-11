import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Orbit, orbitBasis } from './orbit.ts';
import { add, scale, sub } from '../math/vec3.ts';
import { projectToPixel, rayThroughPixel } from './project.ts';

const screen = { width: 1280, height: 800, verticalFovRadians: (50 * Math.PI) / 180 };
const orbit: Orbit = { target: [0, 1, -0.5], yaw: 0.3, pitch: 0.2, distance: 10 };
const close = (a: readonly number[] | null, b: readonly number[], tolerance = 1e-6): void => {
  assert.ok(a !== null, 'projected behind the camera');
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]!) < tolerance, `${a} vs ${b}`));
};

test('a point along the ray through a pixel projects back onto that pixel', () => {
  const camera = orbitBasis(orbit);
  for (const pixel of [
    [0.5, 0.5],
    [640, 400],
    [1279.5, 799.5],
    [100.25, 700.75],
  ] as [number, number][]) {
    const ray = rayThroughPixel(camera, screen, pixel);
    for (const depth of [0.5, 7, 300]) {
      close(projectToPixel(camera, screen, add(camera.position, scale(ray, depth))), pixel, 1e-6 * depth);
    }
  }
});

test('the orbit target sits at the center of the screen', () => {
  close(projectToPixel(orbitBasis(orbit), screen, orbit.target), [640, 400]);
});

test('points behind the camera have no place on screen', () => {
  const camera = orbitBasis(orbit);
  assert.equal(projectToPixel(camera, screen, sub(camera.position, camera.forward)), null);
});

test('turning the orbit moves the scene sideways, as far as the angle covers', () => {
  // Turn by about 2 pixels' worth of angle: the target stays put, and a far
  // point near the target's direction moves sideways by about as much
  // as the camera's angle changed, in pixels.
  const before = orbitBasis(orbit);
  const after = orbitBasis({ ...orbit, yaw: orbit.yaw + 0.002 });
  close(projectToPixel(after, screen, orbit.target), [640, 400]);
  const center = projectToPixel(before, screen, orbit.target);
  assert.ok(center);
  const moved = projectToPixel(after, screen, [5, 1, -3]);
  const was = projectToPixel(before, screen, [5, 1, -3]);
  assert.ok(moved && was);
  assert.ok(Math.abs(moved[1] - was[1]) < 0.5, 'mostly sideways');
  assert.ok(Math.abs(moved[0] - was[0]) > 0.5, 'it moved');
});
