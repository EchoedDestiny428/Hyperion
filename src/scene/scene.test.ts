import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Vec3 } from '../math/vec3.ts';
import {
  BOX_BYTES,
  DAYLIGHT,
  LIGHT_BYTES,
  LIGHT_KIND,
  MATERIAL_BYTES,
  type Material,
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
    floor: { baseColor: { a: [1, 2, 3], b: [4, 5, 6], cellSize: 2 } },
    shiny: { baseColor: [7, 8, 9], roughness: 0.25, metallic: 0.5, ior: 2, transmission: 0.75 },
    lamp: { baseColor: [0, 0, 0], emission: { color: [1, 0.5, 0.25], strength: 4 } },
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
  // floor: a checker, with the defaults filled in.
  assert.deepEqual([...materialFloats.subarray(0, 4)], [1, 2, 3, 1]); // color a; roughness
  assert.deepEqual([...materialFloats.subarray(4, 8)], [4, 5, 6, 2]); // color b; cellSize
  assert.deepEqual([...materialFloats.subarray(8, 14)], [0, 0, 0, 0, 1.5, 0]); // no glow; metallic; ior; transmission
  // shiny: a plain color (cellSize 0), with every value set.
  assert.deepEqual([...materialFloats.subarray(16, 20)], [7, 8, 9, 0.25]);
  assert.equal(materialFloats[23], 0);
  assert.deepEqual([...materialFloats.subarray(27, 30)], [0.5, 2, 0.75]);
  // lamp: color × strength.
  assert.deepEqual([...materialFloats.subarray(40, 43)], [4, 2, 1]);
});

test('tiles pack their two colors, size and grout width', () => {
  const tiled: Scene = {
    ...scene,
    materials: { wall: { baseColor: { tile: [1, 2, 3], grout: [4, 5, 6], cellSize: 0.5, groutWidth: 0.25 } } },
    ground: 'wall',
    spheres: [],
    boxes: [],
  };
  const floats = new Float32Array(packScene(tiled).materials);
  assert.deepEqual([...floats.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([...floats.subarray(4, 8)], [4, 5, 6, 0.5]);
  assert.equal(floats[14], 0.25);
  // Everything else leaves it at 0, which tells the shader there are no tiles.
  assert.equal(new Float32Array(packScene(scene).materials)[14], 0);
});

test('glowing objects store the chance of a shadow ray aiming at each square meter', () => {
  const packed = packScene(scene);
  // The one light, a 2 × 4 × 6 box: always picked, with 88 m² of surface.
  assert.ok(Math.abs((new Float32Array(packed.boxes)[7] ?? 0) - 1 / 88) < 1e-7);
  assert.equal(new Float32Array(packed.spheres)[5], 0); // these spheres don't glow
  assert.equal(findLights(scene)[0]?.density, 1 / 88);
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
  const withMaterial = (material: Material): Scene => ({ ...scene, materials: { ...scene.materials, odd: material } });
  const plain: Vec3 = [1, 1, 1];
  assert.throws(() => packScene(withMaterial({ baseColor: plain, roughness: 1.5 })), /"odd".*roughness/);
  assert.throws(() => packScene(withMaterial({ baseColor: plain, metallic: -1 })), /"odd".*metallic/);
  assert.throws(() => packScene(withMaterial({ baseColor: plain, transmission: 2 })), /"odd".*transmission/);
  assert.throws(() => packScene(withMaterial({ baseColor: plain, ior: 0.5 })), /"odd".*ior/);
  // cellSize 0 means "plain color" to the shader, so a checker can't use it.
  assert.throws(() => packScene(withMaterial({ baseColor: { a: plain, b: plain, cellSize: 0 } })), /"odd".*cellSize/);
  const tiles = (cellSize: number, groutWidth: number): Material => ({
    baseColor: { tile: plain, grout: plain, cellSize, groutWidth },
  });
  assert.throws(() => packScene(withMaterial(tiles(0, 0.1))), /"odd".*cellSize/);
  // groutWidth 0 means "not tiles" to the shader, and a line as wide as a tile leaves no tile.
  assert.throws(() => packScene(withMaterial(tiles(1, 0))), /"odd".*groutWidth/);
  assert.throws(() => packScene(withMaterial(tiles(1, 1))), /"odd".*groutWidth/);
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

test('light kinds and NO_GROUND match the constants in tracer.wgsl', () => {
  const constants = (prefix: string): Record<string, number> =>
    Object.fromEntries(
      [...wgsl.matchAll(new RegExp(`^const ${prefix}_(\\w+) = (\\d+)u;`, 'gm'))].map((m) => [
        (m[1] ?? '').toLowerCase(),
        Number(m[2]),
      ]),
    );
  assert.deepEqual(constants('LIGHT'), LIGHT_KIND);
  assert.match(wgsl, new RegExp(`^const NO_GROUND = ${NO_GROUND}u;`, 'm'));
});

test("the shader's Material fields are in the order packScene writes them", () => {
  const body = /^struct Material \{([^}]*)\}/m.exec(wgsl)?.[1] ?? '';
  const fields = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields, [
    'colorA',
    'roughness',
    'colorB',
    'cellSize',
    'emission',
    'metallic',
    'ior',
    'transmission',
    'groutWidth',
  ]);
});
