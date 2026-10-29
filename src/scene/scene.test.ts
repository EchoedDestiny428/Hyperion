import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MATERIAL_BYTES,
  MATERIAL_KIND,
  SCENE_INFO_BYTES,
  SPHERE_BYTES,
  type Scene,
  heightAboveGround,
  packScene,
  withSphereHeight,
} from './scene.ts';

const scene: Scene = {
  name: 'test',
  camera: { target: [0, 0, 0], yaw: 0, pitch: 0.3, distance: 5 },
  materials: {
    floor: { kind: 'checker', a: [1, 2, 3], b: [4, 5, 6], cellSize: 2 },
    shiny: { kind: 'mirror', tint: [7, 8, 9] },
  },
  ground: 'floor',
  spheres: [
    { center: [1, 2, 3], radius: 4, material: 'shiny' },
    { center: [5, 6, 7], radius: 8, material: 'floor' },
  ],
};

test('fields land at the offsets the structs in tracer.wgsl expect', () => {
  const packed = packScene(scene);

  assert.equal(packed.info.byteLength, SCENE_INFO_BYTES);
  assert.deepEqual([...new Uint32Array(packed.info)], [2, 0, 0, 0]); // 2 spheres, ground = material 0

  assert.equal(packed.spheres.byteLength, 2 * SPHERE_BYTES);
  const sphereFloats = new Float32Array(packed.spheres);
  const sphereInts = new Uint32Array(packed.spheres);
  assert.deepEqual([...sphereFloats.subarray(0, 4)], [1, 2, 3, 4]);
  assert.equal(sphereInts[4], 1); // 'shiny' is the second material
  assert.deepEqual([...sphereFloats.subarray(8, 12)], [5, 6, 7, 8]);
  assert.equal(sphereInts[12], 0);

  assert.equal(packed.materials.byteLength, 2 * MATERIAL_BYTES);
  const materialFloats = new Float32Array(packed.materials);
  const materialInts = new Uint32Array(packed.materials);
  assert.deepEqual([...materialFloats.subarray(0, 3)], [1, 2, 3]);
  assert.equal(materialInts[3], MATERIAL_KIND.checker);
  assert.deepEqual([...materialFloats.subarray(4, 8)], [4, 5, 6, 2]);
  assert.deepEqual([...materialFloats.subarray(8, 11)], [7, 8, 9]);
  assert.equal(materialInts[11], MATERIAL_KIND.mirror);
});

test('an empty scene still gets one sphere slot, since a storage binding cannot be empty', () => {
  const packed = packScene({ ...scene, spheres: [] });
  assert.equal(packed.spheres.byteLength, SPHERE_BYTES);
  assert.equal(new Uint32Array(packed.info)[0], 0);
});

test('using a material the scene does not define is an error', () => {
  assert.throws(() => packScene({ ...scene, ground: 'lava' }), /lava/);
  assert.throws(() => packScene({ ...scene, spheres: [{ center: [0, 0, 0], radius: 1, material: 'lava' }] }), /lava/);
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

test('material kind numbers match the KIND_* constants in tracer.wgsl', () => {
  const wgsl = readFileSync(new URL('../render/tracer.wgsl', import.meta.url), 'utf8');
  const inShader = Object.fromEntries(
    [...wgsl.matchAll(/^const KIND_(\w+) = (\d+)u;/gm)].map((m) => [(m[1] ?? '').toLowerCase(), Number(m[2])]),
  );
  assert.deepEqual(inShader, MATERIAL_KIND);
});
