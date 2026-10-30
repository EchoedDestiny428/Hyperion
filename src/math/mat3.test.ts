import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, applyMat3, rotationFromDegrees } from './mat3.ts';
import { type Vec3, cross, dot, length } from './vec3.ts';

const close = (a: Vec3, b: Vec3): void => {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i]! - b[i]!) < 1e-12, `${a} vs ${b}`);
};

test('no rotation is the identity', () => {
  assert.deepEqual(rotationFromDegrees([0, 0, 0]), IDENTITY);
});

test('90° turns follow the right-hand rule', () => {
  close(applyMat3(rotationFromDegrees([0, 90, 0]), [1, 0, 0]), [0, 0, -1]); // about y: x → -z
  close(applyMat3(rotationFromDegrees([90, 0, 0]), [0, 1, 0]), [0, 0, 1]); // about x: y → z
  close(applyMat3(rotationFromDegrees([0, 0, 90]), [1, 0, 0]), [0, 1, 0]); // about z: x → y
});

test('angles apply in the order x, then y, then z', () => {
  // x by 90° takes y to z; then y by 90° takes z to x.
  close(applyMat3(rotationFromDegrees([90, 90, 0]), [0, 1, 0]), [1, 0, 0]);
});

test('any rotation keeps lengths and right angles, and stays right-handed', () => {
  const [a, b, c] = rotationFromDegrees([25, -40, 70]);
  for (const v of [a, b, c]) assert.ok(Math.abs(length(v) - 1) < 1e-12);
  assert.ok(Math.abs(dot(a, b)) < 1e-12 && Math.abs(dot(b, c)) < 1e-12 && Math.abs(dot(a, c)) < 1e-12);
  close(cross(a, b), c);
});
