import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotationFromDegrees } from '../../math/mat3.ts';
import { findLights } from '../scene.ts';
import { type Block, SHORT_BLOCK, TALL_BLOCK, cornellBox } from './cornell-box.ts';

const boxes = cornellBox.boxes ?? [];
const SCALE = 0.01; // meters per Cornell millimeter
const inMillimeters = (x: number, z: number): [number, number] => [278 - x / SCALE, 279.6 - z / SCALE];

// Where the corners of a built box land, in Cornell's numbers.
function cornersOf(index: number): [number, number][] {
  const box = boxes[index];
  assert.ok(box?.rotation);
  const [xAxis, , zAxis] = rotationFromDegrees(box.rotation);
  const [w, , d] = box.size;
  return [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([sx = 0, sz = 0]) => {
    const x = box.center[0] + (xAxis[0] * sx * w) / 2 + (zAxis[0] * sz * d) / 2;
    const z = box.center[2] + (xAxis[2] * sx * w) / 2 + (zAxis[2] * sz * d) / 2;
    return inMillimeters(x, z);
  });
}

// A built box's corners can start from any corner, so match each published one
// with the nearest built one.
function assertMatches(index: number, block: Block): void {
  const built = cornersOf(index);
  for (const [x, z] of block.corners) {
    const nearest = Math.min(...built.map(([bx, bz]) => Math.hypot(bx - x, bz - z)));
    assert.ok(nearest < 3, `corner (${x}, ${z}) of the published block is ${nearest.toFixed(1)} mm from the built one`);
  }
}

test('the blocks land on the corners Cornell measured, within 3 mm', () => {
  assertMatches(boxes.length - 2, SHORT_BLOCK);
  assertMatches(boxes.length - 1, TALL_BLOCK);
});

test('the blocks stand on the floor', () => {
  for (const box of boxes.slice(-2)) assert.ok(Math.abs(box.center[1] - box.size[1] / 2) < 1e-9);
});

test('the red wall is on the left and the green wall on the right, seen from the camera', () => {
  const x = (material: string): number => boxes.find((box) => box.material === material)?.center[0] ?? 0;
  assert.ok(x('red') < 0);
  assert.ok(x('green') > 0);
});

test('the panel is the only light', () => {
  assert.deepEqual(cornellBox.environment, { sun: [0, 0, 0], sky: 0 });
  assert.equal(findLights(cornellBox).length, 1);
});
