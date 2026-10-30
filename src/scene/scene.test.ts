import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOX_BYTES,
  DAYLIGHT,
  LIGHT_BYTES,
  LIGHT_KIND,
  MATERIAL_BYTES,
  MATERIAL_KIND,
  NO_GROUND,
  SCENE_INFO_BYTES,
  SPHERE_BYTES,
  type Scene,
  findLights,
  heightAboveGround,
  packScene,
  withSphereHeight,
} from './scene.ts';

const scene: Scene = {
  name: 'test',
  camera: { target: [0, 0, 0], yaw: 0, pitch: 0.3, distance: 5 },
  materials: {
    floor: { kind: 'checker', a: [1, 2, 3], b: [4, 5, 6], cellSize: 2, reflectivity: 0.25 },
    shiny: { kind: 'mirror', tint: [7, 8, 9] },
    lamp: { kind: 'diffuse', albedo: [0, 0, 0], emission: { color: [1, 0.5, 0.25], strength: 4 } },
  },
  ground: 'floor',
  spheres: [
    { center: [1, 2, 3], radius: 4, material: 'shiny' },
    { center: [5, 6, 7], radius: 8, material: 'floor' },
  ],
  boxes: [{ center: [1, 2, 3], size: [2, 4, 6], rotation: [0, 90, 0], material: 'lamp' }],
  environment: { sun: [0.5, 0.25, 0.125], sky: 0.5 },
};

const wgsl = readFileSync(new URL('../render/tracer.wgsl', import.meta.url), 'utf8');
const close = (actual: Iterable<number>, expected: number[]): void => {
  const a = [...actual];
  assert.equal(a.length, expected.length);
  a.forEach((x, i) => assert.ok(Math.abs(x - expected[i]!) < 1e-6, `${a} vs ${expected}`));
};

test('scene info, spheres and materials land where tracer.wgsl expects', () => {
  const packed = packScene(scene);

  assert.equal(packed.info.byteLength, SCENE_INFO_BYTES);
  assert.deepEqual([...new Uint32Array(packed.info).subarray(0, 4)], [2, 1, 1, 0]); // spheres, boxes, lights, ground
  assert.deepEqual([...new Float32Array(packed.info).subarray(4, 8)], [0.5, 0.25, 0.125, 0.5]); // sun, sky

  assert.equal(packed.spheres.byteLength, 2 * SPHERE_BYTES);
  const sphereFloats = new Float32Array(packed.spheres);
  const sphereInts = new Uint32Array(packed.spheres);
  assert.deepEqual([...sphereFloats.subarray(0, 4)], [1, 2, 3, 4]);
  assert.equal(sphereInts[4], 1); // 'shiny' is the second material
  assert.deepEqual([...sphereFloats.subarray(8, 12)], [5, 6, 7, 8]);
  assert.equal(sphereInts[12], 0);

  assert.equal(packed.materials.byteLength, 3 * MATERIAL_BYTES);
  const materialFloats = new Float32Array(packed.materials);
  const materialInts = new Uint32Array(packed.materials);
  assert.deepEqual([...materialFloats.subarray(0, 3)], [1, 2, 3]);
  assert.equal(materialInts[3], MATERIAL_KIND.checker);
  assert.deepEqual([...materialFloats.subarray(4, 8)], [4, 5, 6, 2]);
  assert.deepEqual([...materialFloats.subarray(8, 12)], [0, 0, 0, 0.25]); // no glow; reflectivity
  assert.deepEqual([...materialFloats.subarray(12, 15)], [7, 8, 9]);
  assert.equal(materialInts[15], MATERIAL_KIND.mirror);
  assert.deepEqual([...materialFloats.subarray(32, 35)], [4, 2, 1]); // lamp: color × strength
});

test('boxes store their center, half size and rotation columns', () => {
  const packed = packScene(scene);
  assert.equal(packed.boxes.byteLength, BOX_BYTES);
  const floats = new Float32Array(packed.boxes);
  const ints = new Uint32Array(packed.boxes);
  assert.deepEqual([...floats.subarray(0, 3)], [1, 2, 3]);
  assert.equal(ints[3], 2); // 'lamp'
  assert.deepEqual([...floats.subarray(4, 7)], [1, 2, 3]); // half of [2, 4, 6]
  // 90° about y: x → -z, y → y, z → x.
  close(floats.subarray(8, 11), [0, 0, -1]);
  close(floats.subarray(12, 15), [0, 1, 0]);
  close(floats.subarray(16, 19), [1, 0, 0]);
});

test('glowing objects become lights, picked in proportion to the light they give off', () => {
  const two: Scene = {
    ...scene,
    spheres: [{ center: [0, 0, 0], radius: 1, material: 'lamp' }],
    boxes: [{ center: [0, 0, 0], size: [1, 1, 1], material: 'lamp' }],
  };
  const lights = findLights(two);
  assert.deepEqual(
    lights.map((l) => [l.kind, l.index]),
    [
      ['sphere', 0],
      ['box', 0],
    ],
  );
  // Same material, so the share is by area: sphere 4π, box 6.
  assert.ok(Math.abs((lights[0]?.probability ?? 0) - (4 * Math.PI) / (4 * Math.PI + 6)) < 1e-12);

  const packed = new DataView(packScene(two).lights);
  assert.equal(packed.byteLength, 2 * LIGHT_BYTES);
  assert.equal(packed.getUint32(16, true), LIGHT_KIND.box);
  assert.equal(packed.getFloat32(16 + 8, true), 1); // the running total ends at exactly 1
});

test('leaving things out: no ground, no boxes, no lights, default daylight', () => {
  const bare: Scene = { name: 'bare', camera: scene.camera, materials: scene.materials, spheres: [] };
  const packed = packScene(bare);
  const ints = new Uint32Array(packed.info);
  assert.deepEqual([...ints.subarray(0, 4)], [0, 0, 0, NO_GROUND]);
  close(new Float32Array(packed.info).subarray(4, 8), [...DAYLIGHT.sun, DAYLIGHT.sky]);
  // A storage binding can't be empty, so each list still gets one slot.
  assert.equal(packed.spheres.byteLength, SPHERE_BYTES);
  assert.equal(packed.boxes.byteLength, BOX_BYTES);
  assert.equal(packed.lights.byteLength, LIGHT_BYTES);
});

test('mistakes in a layout are errors, not wrong pictures', () => {
  assert.throws(() => packScene({ ...scene, ground: 'lava' }), /lava/);
  assert.throws(() => packScene({ ...scene, spheres: [{ center: [0, 0, 0], radius: 1, material: 'lava' }] }), /lava/);
  assert.throws(() => packScene({ ...scene, boxes: [{ center: [0, 0, 0], size: [1, 0, 1], material: 'lamp' }] }), /size/);
});

test('withSphereHeight moves one sphere and leaves the original scene alone', () => {
  const lifted = withSphereHeight(scene, 0, 2.5);
  assert.notEqual(lifted, scene);
  const sphere = lifted.spheres[0];
  assert.ok(sphere);
  assert.deepEqual(sphere.center, [1, 6.5, 3]); // gap 2.5 + radius 4
  assert.equal(heightAboveGround(sphere), 2.5);
  assert.equal(lifted.spheres[1], scene.spheres[1]);
  assert.deepEqual(scene.spheres[0]?.center, [1, 2, 3]);
});

test('kind numbers and NO_GROUND match the constants in tracer.wgsl', () => {
  const constants = (prefix: string): Record<string, number> =>
    Object.fromEntries(
      [...wgsl.matchAll(new RegExp(`^const ${prefix}_(\\w+) = (\\d+)u;`, 'gm'))].map((m) => [
        (m[1] ?? '').toLowerCase(),
        Number(m[2]),
      ]),
    );
  assert.deepEqual(constants('KIND'), MATERIAL_KIND);
  assert.deepEqual(constants('LIGHT'), LIGHT_KIND);
  assert.match(wgsl, new RegExp(`^const NO_GROUND = ${NO_GROUND}u;`, 'm'));
});
