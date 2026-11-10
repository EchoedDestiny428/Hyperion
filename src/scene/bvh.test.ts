import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, applyMat3, rotationFromDegrees } from '../math/mat3.ts';
import { type Vec3, dot } from '../math/vec3.ts';
import {
  BOUNDS_MARGIN,
  BOX_ITEM_BIT,
  BVH_NODE_BYTES,
  type Bounds,
  type Bvh,
  MAX_DEPTH,
  MAX_LEAF_ITEMS,
  boxBounds,
  buildBvh,
  depthFirst,
  itemsOf,
  packBvh,
} from './bvh.ts';
import { SCENES } from './registry.ts';
import type { Box, Scene, Sphere } from './scene.ts';

// A repeatable stream of random numbers, so a failure can be reproduced.
function randomStream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// ---- The same intersection tests as tracer.wgsl, in double precision ----
const EPSILON = 1e-3;

function hitSphere(origin: Vec3, dir: Vec3, s: Sphere): number {
  const oc: Vec3 = [origin[0] - s.center[0], origin[1] - s.center[1], origin[2] - s.center[2]];
  const b = dot(oc, dir);
  const c = dot(oc, oc) - s.radius * s.radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return Infinity;
  const root = Math.sqrt(discriminant);
  let t = -b - root;
  if (t < EPSILON) t = -b + root;
  return t < EPSILON ? Infinity : t;
}

function hitBox(origin: Vec3, dir: Vec3, box: Box): number {
  const axes = box.rotation ? rotationFromDegrees(box.rotation) : IDENTITY;
  const relative: Vec3 = [origin[0] - box.center[0], origin[1] - box.center[1], origin[2] - box.center[2]];
  // Into the box's coordinates: one dot product with each of its axes.
  const o = axes.map((axis) => dot(relative, axis));
  const d = axes.map((axis) => dot(dir, axis));
  let enter = -Infinity;
  let exit = Infinity;
  for (let i = 0; i < 3; i++) {
    const h = (box.size[i] ?? 0) / 2;
    const di = Math.abs(d[i]!) < 1e-20 ? 1e-20 : d[i]!;
    const a = (-h - o[i]!) / di;
    const b = (h - o[i]!) / di;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  if (enter > exit || exit < EPSILON) return Infinity;
  return enter < EPSILON ? exit : enter;
}

interface Found {
  t: number;
  item: string; // "sphere 3" or "box 7"
}

function bruteForce(scene: Scene, origin: Vec3, dir: Vec3): Found {
  let best: Found = { t: Infinity, item: 'nothing' };
  scene.spheres.forEach((s, i) => {
    const t = hitSphere(origin, dir, s);
    if (t < best.t) best = { t, item: `sphere ${i}` };
  });
  (scene.boxes ?? []).forEach((b, i) => {
    const t = hitBox(origin, dir, b);
    if (t < best.t) best = { t, item: `box ${i}` };
  });
  return best;
}

// Where a ray enters a bounding box, or Infinity if it misses it or only
// meets it at `limit` or beyond.
function entry(origin: Vec3, inverse: Vec3, { min, max }: Bounds, limit: number): number {
  let enter = 0;
  let exit = limit;
  for (let i = 0; i < 3; i++) {
    const a = (min[i]! - origin[i]!) * inverse[i]!;
    const b = (max[i]! - origin[i]!) * inverse[i]!;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  return enter <= exit ? enter : Infinity;
}

// The walk the shader does, on the depth-first layout: reach a node's box
// before the closest hit so far and go on to the next node; miss it, and an
// inner node's link skips its subtree.
function walk(bvh: Bvh, scene: Scene, origin: Vec3, dir: Vec3): Found {
  let best: Found = { t: Infinity, item: 'nothing' };
  const inverse = dir.map((c) => 1 / (Math.abs(c) < 1e-20 ? 1e-20 : c)) as unknown as Vec3;
  let node = 0;
  while (node < bvh.nodes.length) {
    const n = bvh.nodes[node]!;
    const reached = entry(origin, inverse, n.bounds, best.t) < best.t;
    if (reached && n.count > 0) {
      for (const item of bvh.items.slice(n.first, n.first + n.count)) {
        const t =
          item.kind === 'sphere'
            ? hitSphere(origin, dir, scene.spheres[item.index]!)
            : hitBox(origin, dir, scene.boxes![item.index]!);
        if (t < best.t) best = { t, item: `${item.kind} ${item.index}` };
      }
    }
    node = !reached && n.count === 0 ? n.first : node + 1;
  }
  return best;
}

// ---- Scenes to test on: every layout, plus a big random one ----
function randomScene(count: number, seed: number): Scene {
  const random = randomStream(seed);
  const spread = (): number => (random() - 0.5) * 40;
  const spheres: Sphere[] = [];
  const boxes: Box[] = [];
  for (let i = 0; i < count; i++) {
    const center: Vec3 = [spread(), spread() / 4 + 5, spread()];
    if (random() < 0.5) spheres.push({ center, radius: 0.1 + random(), material: 'm' });
    else {
      const size: Vec3 = [0.05 + random() * 3, 0.05 + random() * 3, 0.05 + random() * 3];
      const rotation: Vec3 = [random() * 360, random() * 360, random() * 360];
      boxes.push({ center, size, rotation, material: 'm' });
    }
  }
  return { name: 'random', camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5 }, materials: {}, spheres, boxes };
}

const testScenes: Scene[] = [...SCENES, randomScene(400, 7)];

function sceneBvh(scene: Scene): Bvh {
  return buildBvh(itemsOf(scene.spheres, scene.boxes ?? []));
}

test('a turned box’s bounds touch its farthest corners, plus the margin', () => {
  const box: Box = { center: [1, 2, 3], size: [2, 0.5, 4], rotation: [10, 35, -20], material: 'm' };
  const bounds = boxBounds(box);
  const axes = rotationFromDegrees([10, 35, -20]);
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const local: Vec3 = [(sx * box.size[0]) / 2, (sy * box.size[1]) / 2, (sz * box.size[2]) / 2];
    const p = applyMat3(axes, local);
    corners.push([p[0] + 1, p[1] + 2, p[2] + 3]);
  }
  for (let i = 0; i < 3; i++) {
    const values = corners.map((c) => c[i]!);
    assert.ok(Math.abs(Math.min(...values) - BOUNDS_MARGIN - bounds.min[i]!) < 1e-12, `min ${i}`);
    assert.ok(Math.abs(Math.max(...values) + BOUNDS_MARGIN - bounds.max[i]!) < 1e-12, `max ${i}`);
  }
});

test('every object is in exactly one leaf, and every box encloses what is below it', () => {
  const contains = (outer: Bounds, inner: Bounds): boolean =>
    [0, 1, 2].every((i) => outer.min[i]! <= inner.min[i]! && outer.max[i]! >= inner.max[i]!);
  for (const scene of testScenes) {
    const bvh = sceneBvh(scene);
    const seen = new Set<string>();
    const visit = (index: number, depth: number): void => {
      const node = bvh.nodes[index]!;
      assert.ok(depth <= MAX_DEPTH, `${scene.name}: depth ${depth}`);
      if (node.count > 0) {
        for (const item of bvh.items.slice(node.first, node.first + node.count)) {
          assert.ok(contains(node.bounds, item.bounds), `${scene.name}: a leaf doesn't enclose its object`);
          const key = `${item.kind} ${item.index}`;
          assert.ok(!seen.has(key), `${scene.name}: ${key} appears twice`);
          seen.add(key);
        }
        return;
      }
      for (const child of [node.first, node.first + 1]) {
        assert.ok(contains(node.bounds, bvh.nodes[child]!.bounds), `${scene.name}: a node doesn't enclose its child`);
        visit(child, depth + 1);
      }
    };
    if (bvh.nodes.length > 0) visit(0, 1);
    assert.equal(seen.size, scene.spheres.length + (scene.boxes ?? []).length, scene.name);
  }
});

test('leaves stay small, so a ray tests only a few objects in each', () => {
  for (const scene of testScenes) {
    for (const node of sceneBvh(scene).nodes) assert.ok(node.count <= MAX_LEAF_ITEMS, `${scene.name}: a leaf of ${node.count}`);
  }
});

test('walking the tree finds the same closest object as testing every object', () => {
  const random = randomStream(42);
  for (const scene of testScenes) {
    const bvh = depthFirst(sceneBvh(scene));
    for (let i = 0; i < 2000; i++) {
      const origin: Vec3 = [(random() - 0.5) * 30, random() * 12, (random() - 0.5) * 30];
      const z = random() * 2 - 1;
      const r = Math.sqrt(1 - z * z);
      const angle = random() * 2 * Math.PI;
      const dir: Vec3 = [r * Math.cos(angle), z, r * Math.sin(angle)];
      const expected = bruteForce(scene, origin, dir);
      const found = walk(bvh, scene, origin, dir);
      assert.equal(found.item, expected.item, `${scene.name}, ray ${i}`);
      assert.equal(found.t, expected.t, `${scene.name}, ray ${i}`);
    }
  }
});

test('many objects in one spot still make a tree no deeper than the limit', () => {
  const same: Sphere[] = Array.from({ length: 300 }, () => ({ center: [0, 1, 0], radius: 1, material: 'm' }));
  const bvh = buildBvh(itemsOf(same, []));
  let deepest = 0;
  const visit = (index: number, depth: number): void => {
    deepest = Math.max(deepest, depth);
    const node = bvh.nodes[index]!;
    if (node.count === 0) for (const child of [node.first, node.first + 1]) visit(child, depth + 1);
  };
  visit(0, 1);
  assert.ok(deepest <= MAX_DEPTH);
  assert.equal(bvh.items.length, 300);
});

test('an empty scene has an empty tree, still packed into one slot', () => {
  const bvh = buildBvh([]);
  assert.equal(bvh.nodes.length, 0);
  const packed = packBvh(bvh);
  assert.equal(packed.nodes.byteLength, BVH_NODE_BYTES);
  assert.equal(packed.items.byteLength, 4);
});

test('nodes and items land where tracer.wgsl expects', () => {
  const spheres: Sphere[] = [{ center: [0, 0, 0], radius: 1, material: 'm' }];
  const boxes: Box[] = [{ center: [5, 0, 0], size: [2, 2, 2], material: 'm' }];
  const bvh = buildBvh(itemsOf(spheres, boxes));
  const packed = packBvh(bvh);
  assert.equal(packed.nodes.byteLength, bvh.nodes.length * BVH_NODE_BYTES);
  const floats = new Float32Array(packed.nodes);
  const ints = new Uint32Array(packed.nodes);
  const root = bvh.nodes[0]!;
  assert.deepEqual([...floats.subarray(0, 3)], [...root.bounds.min].map(Math.fround));
  assert.equal(ints[3], root.first);
  assert.deepEqual([...floats.subarray(4, 7)], [...root.bounds.max].map(Math.fround));
  assert.equal(ints[7], root.count);
  const items = [...new Uint32Array(packed.items)];
  assert.deepEqual(
    items.sort(),
    [0, (0 | BOX_ITEM_BIT) >>> 0].sort(), // sphere 0, and box 0 with the top bit set
  );
});

test('the shader’s box marker matches', async () => {
  const { readFileSync } = await import('node:fs');
  const wgsl = readFileSync(new URL('../render/tracer.wgsl', import.meta.url), 'utf8');
  assert.match(wgsl, new RegExp(`^const BOX_ITEM_BIT = ${BOX_ITEM_BIT}u;`, 'm'));
});

test('depth first: each inner node is followed by its subtree, and its link points just past it', () => {
  for (const scene of testScenes) {
    const flat = depthFirst(sceneBvh(scene));
    // Returns the index just past the subtree starting at `index`.
    const subtreeEnd = (index: number): number => {
      const node = flat.nodes[index]!;
      if (node.count > 0) return index + 1;
      const afterLeft = subtreeEnd(index + 1);
      const end = subtreeEnd(afterLeft);
      assert.equal(node.first, end, `${scene.name}: node ${index}'s link`);
      return end;
    };
    if (flat.nodes.length > 0) assert.equal(subtreeEnd(0), flat.nodes.length, scene.name);
  }
});
