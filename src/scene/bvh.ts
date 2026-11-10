import { IDENTITY, rotationFromDegrees } from '../math/mat3.ts';
import type { Vec3 } from '../math/vec3.ts';
import type { Box, Sphere } from './scene.ts';

// A bounding volume hierarchy (BVH): a tree of boxes, each enclosing the
// objects below it, so a ray can skip every object inside a box it misses.
// Without one, every ray tests every object; with one, a ray in a scene of n
// objects tests roughly log₂ n boxes and a few objects.
//
// It's built on the CPU when a scene is uploaded, and the shader walks it
// (intersectScene in tracer.wgsl). The boxes here are axis-aligned bounding
// boxes, "AABBs": lined up with the world's axes, which makes testing a ray
// against them cheap.

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

// One object, as the BVH sees it: where to find it, and the box around it.
export interface BvhItem {
  kind: 'sphere' | 'box';
  index: number; // into Scene.spheres or Scene.boxes
  bounds: Bounds;
}

// A node is either a leaf holding `count` items, starting at items[first], or
// (count 0) an inner node whose two children are nodes[first] and
// nodes[first + 1]. Keeping the children side by side means a node needs only
// one index for both.
export interface BvhNode {
  bounds: Bounds;
  first: number;
  count: number;
}

export interface Bvh {
  nodes: BvhNode[]; // nodes[0] is the root; empty if there are no objects
  items: BvhItem[]; // reordered, so each leaf's items sit together
}

// Leaves hold at most this many objects, unless splitting stops paying off.
export const MAX_LEAF_ITEMS = 4;
// A limit on the tree's depth, so a scene of many objects in one spot can't
// make a long chain of nodes that each split off one object.
export const MAX_DEPTH = 32;

// Rough relative costs of the two kinds of work a ray does, for the surface
// area heuristic below. Testing a box node and an object cost about the same.
const NODE_COST = 1;
const ITEM_COST = 1;

// Every bounding box is made this much bigger on all sides (0.1 mm). A box's
// faces lie exactly on its bounding box's faces, and the shader works out the
// two tests with slightly different rounding, so without a margin a ray
// grazing a wall could pass the wall's own test but "miss" its bounding box,
// leaving holes.
export const BOUNDS_MARGIN = 1e-4;

function around([x, y, z]: Vec3, [rx, ry, rz]: Vec3): Bounds {
  const m = BOUNDS_MARGIN;
  return { min: [x - rx - m, y - ry - m, z - rz - m], max: [x + rx + m, y + ry + m, z + rz + m] };
}

export function sphereBounds(sphere: Sphere): Bounds {
  const r = sphere.radius;
  return around(sphere.center, [r, r, r]);
}

// A turned box reaches out along each world axis by the sum of its own half
// sizes, each scaled by how much that axis of the box points along the world
// axis.
export function boxBounds(box: Box): Bounds {
  const [x, y, z] = box.rotation ? rotationFromDegrees(box.rotation) : IDENTITY; // the box's axes
  const [hx, hy, hz] = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
  const reach = (axis: 0 | 1 | 2): number =>
    Math.abs(x[axis]) * hx + Math.abs(y[axis]) * hy + Math.abs(z[axis]) * hz;
  return around(box.center, [reach(0), reach(1), reach(2)]);
}

export function itemsOf(spheres: readonly Sphere[], boxes: readonly Box[]): BvhItem[] {
  return [
    ...spheres.map((sphere, index) => ({ kind: 'sphere' as const, index, bounds: sphereBounds(sphere) })),
    ...boxes.map((box, index) => ({ kind: 'box' as const, index, bounds: boxBounds(box) })),
  ];
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function surfaceArea({ min, max }: Bounds): number {
  const [dx, dy, dz] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function centroid({ min, max }: Bounds, axis: number): number {
  return ((min[axis] ?? 0) + (max[axis] ?? 0)) / 2;
}

function enclose(items: readonly BvhItem[]): Bounds {
  return items.map((item) => item.bounds).reduce(union);
}

interface Split {
  axis: number;
  leftCount: number; // after sorting along the axis, the first leftCount items go left
  cost: number;
}

// The surface area heuristic (SAH). A random ray that hits a box hits a box
// inside it with a chance of about (inner box's surface area ÷ outer box's).
// So the expected cost of a split is: test both children's boxes, plus each
// child's objects times the chance of reaching that child. This tries every
// split of the objects sorted along each axis and keeps the cheapest.
// MacDonald & Booth, "Heuristics for ray tracing using space subdivision" (1990).
function bestSplit(items: readonly BvhItem[], parentArea: number): Split {
  let best: Split = { axis: 0, leftCount: 0, cost: Number.POSITIVE_INFINITY };
  for (const axis of [0, 1, 2]) {
    const sorted = [...items].sort((a, b) => centroid(a.bounds, axis) - centroid(b.bounds, axis));
    // The area of the box around the last k items, for every k, swept from the right.
    const rightAreas: number[] = new Array(sorted.length).fill(0);
    let right: Bounds | null = null;
    for (let k = sorted.length - 1; k > 0; k--) {
      right = right ? union(right, sorted[k]!.bounds) : sorted[k]!.bounds;
      rightAreas[k] = surfaceArea(right);
    }
    let left: Bounds | null = null;
    for (let k = 1; k < sorted.length; k++) {
      left = left ? union(left, sorted[k - 1]!.bounds) : sorted[k - 1]!.bounds;
      const cost =
        2 * NODE_COST + (ITEM_COST * (surfaceArea(left) * k + (rightAreas[k] ?? 0) * (sorted.length - k))) / parentArea;
      if (cost < best.cost) best = { axis, leftCount: k, cost };
    }
  }
  return best;
}

export function buildBvh(items: readonly BvhItem[]): Bvh {
  const ordered = [...items];
  const nodes: BvhNode[] = [];
  if (ordered.length === 0) return { nodes, items: ordered };
  nodes.push({ bounds: enclose(ordered), first: 0, count: ordered.length });

  const split = (nodeIndex: number, depth: number): void => {
    const node = nodes[nodeIndex]!;
    const { first, count } = node;
    // At the depth limit, a node stays a leaf however many objects it holds:
    // slower for those rays, but never wrong.
    if (count <= 1 || depth >= MAX_DEPTH) return;
    const these = ordered.slice(first, first + count);
    const best = bestSplit(these, surfaceArea(node.bounds));
    // Splitting a small group can cost more than testing its objects directly.
    if (count <= MAX_LEAF_ITEMS && best.cost >= ITEM_COST * count) return;

    these.sort((a, b) => centroid(a.bounds, best.axis) - centroid(b.bounds, best.axis));
    ordered.splice(first, count, ...these);
    const leftItems = these.slice(0, best.leftCount);
    const rightItems = these.slice(best.leftCount);
    const leftIndex = nodes.length;
    nodes.push(
      { bounds: enclose(leftItems), first, count: leftItems.length },
      { bounds: enclose(rightItems), first: first + leftItems.length, count: rightItems.length },
    );
    node.first = leftIndex;
    node.count = 0;
    split(leftIndex, depth + 1);
    split(leftIndex + 1, depth + 1);
  };
  split(0, 1);
  return { nodes, items: ordered };
}

// The same tree, stored for walking without a stack. Nodes are listed in
// depth-first order (a node, then everything in its left child, then
// everything in its right child), so after a node comes its first child, and
// after a leaf comes whatever the walk should visit next. An inner node keeps
// one link, `first`, to the node after its whole subtree: where to go if a
// ray misses its box. A leaf's `first` still points at its items.
//
// The walk then needs no list of nodes still to visit: hit a box, go to the
// next node; miss it, follow its link. Integrated GPUs have little fast memory
// per pixel, and a list there can slow every ray down. Smits, "Efficiency
// issues for ray tracing" (1998), https://doi.org/10.1080/10867651.1998.10487488
export function depthFirst(bvh: Bvh): Bvh {
  const nodes: BvhNode[] = [];
  const visit = (index: number): void => {
    const node = bvh.nodes[index]!;
    const at = nodes.length;
    nodes.push({ bounds: node.bounds, first: node.first, count: node.count });
    if (node.count > 0) return;
    visit(node.first);
    visit(node.first + 1);
    nodes[at]!.first = nodes.length; // past the subtree: where to go on a miss
  };
  if (bvh.nodes.length > 0) visit(0);
  return { nodes, items: bvh.items };
}

// Byte layout of the shader's structs, as in scene.ts:
//   BvhNode  slot 0..2 boundsMin  3 first (u32)  4..6 boundsMax  7 count (u32)
//   items    one u32 each: the object's index, with the top bit set for a box
export const BVH_NODE_BYTES = 32;
export const BOX_ITEM_BIT = 0x80000000;

export interface PackedBvh {
  nodes: ArrayBuffer;
  items: ArrayBuffer;
}

export function packBvh(bvh: Bvh): PackedBvh {
  // A storage buffer binding can't be empty, so an empty tree still gets one
  // slot of each; the shader doesn't walk the tree when there are no objects.
  const nodes = new ArrayBuffer(BVH_NODE_BYTES * Math.max(bvh.nodes.length, 1));
  const floats = new Float32Array(nodes);
  const ints = new Uint32Array(nodes);
  bvh.nodes.forEach((node, i) => {
    const base = (i * BVH_NODE_BYTES) / 4;
    floats.set(node.bounds.min, base);
    ints[base + 3] = node.first;
    floats.set(node.bounds.max, base + 4);
    ints[base + 7] = node.count;
  });
  const items = new Uint32Array(Math.max(bvh.items.length, 1));
  bvh.items.forEach((item, i) => {
    items[i] = item.kind === 'box' ? (item.index | BOX_ITEM_BIT) >>> 0 : item.index;
  });
  return { nodes, items: items.buffer };
}
