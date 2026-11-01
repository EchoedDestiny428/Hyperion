import type { Vec3 } from '../../math/vec3.ts';
import { type Box, type Scene, boxBetween } from '../scene.ts';

// The Cornell box: a white room with one red wall and one green wall, lit only
// by a panel in its ceiling. Cornell built a real one in 1984 and measured it,
// so that a render could be compared with a photograph. It's still the standard
// test for bounce light, because the only way color reaches the white surfaces
// is by bouncing off the walls.
//
// The numbers are Cornell's published measurements, in millimeters. Their data
// page has moved (https://en-cg-web.coecis.cornell.edu/online/box/data.html
// wasn't reachable on 2026-11-01), so these come from the copy in Intel's Embree
// project: https://github.com/tinyobjloader/tinyobjloader/blob/release/models/cornell_box.obj
// Cornell measured color across the spectrum. The RGB versions here are from
// Benedikt Bitterli's public-domain (CC0) scene: https://benedikt-bitterli.me/resources/

// One millimeter of Cornell's is 1 cm here, so the room is 5.5 m wide, and the
// shader's 1 mm offset (EPSILON) stays small next to the gaps it has to fit
// into. Light doesn't change with scale, so the image is the same.
const SCALE = 0.01;
const WIDTH = 556;
const HEIGHT = 548.8;
const DEPTH = 559.2;
const WALL = 30; // thickness of the walls, which aren't part of the measurements

// Cornell's axes face the other way: they look along +z, with x to the left.
// Our cameras start out looking along -z, so this turns the room around,
// keeping its center on the y axis. Turning doesn't mirror it, so the red wall
// stays on the left.
const place = (x: number, y: number, z: number): Vec3 => [(WIDTH / 2 - x) * SCALE, y * SCALE, (DEPTH / 2 - z) * SCALE];

// The real box is slightly crooked: the red wall isn't flat, and it's between
// 549.6 and 556 from the green wall. A box can't lean, so this is its average.
const RED_WALL = 553.6;

// A box between two corners given in Cornell's numbers, in any order.
const wall = (a: Vec3, b: Vec3, material: string): Box => {
  const [p, q] = [place(...a), place(...b)];
  const min: Vec3 = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])];
  const max: Vec3 = [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])];
  return boxBetween(min, max, material);
};

// A block's four corners as seen from above, as (x, z) in Cornell's numbers.
export interface Block {
  height: number;
  corners: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
}

export const SHORT_BLOCK: Block = {
  height: 165,
  corners: [
    [130, 65],
    [82, 225],
    [240, 272],
    [290, 114],
  ],
};

export const TALL_BLOCK: Block = {
  height: 330,
  corners: [
    [423, 247],
    [265, 296],
    [314, 456],
    [472, 406],
  ],
};

// The measured corners aren't a perfect square either, so this takes the
// average of each pair of opposite sides, and their angle.
const blockBox = ({ height, corners: [a, b, c, d] }: Block): Box => {
  const length = (p: readonly [number, number], q: readonly [number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const middle = (i: 0 | 1): number => (a[i] + b[i] + c[i] + d[i]) / 4;
  // Turned around like the room, the side from a to d runs the opposite way,
  // which makes no difference to a box. rotationFromDegrees sends a box's x axis
  // to (cos, 0, -sin).
  const degrees = (Math.atan2(d[1] - a[1], a[0] - d[0]) * 180) / Math.PI;
  return {
    center: place(middle(0), height / 2, middle(1)),
    size: [
      ((length(a, d) + length(b, c)) / 2) * SCALE,
      height * SCALE,
      ((length(a, b) + length(c, d)) / 2) * SCALE,
    ],
    rotation: [0, degrees, 0],
    material: 'white',
  };
};

export const cornellBox: Scene = {
  name: 'cornell-box',
  // Back far enough to see the whole front opening, which is the side with no wall.
  camera: { target: [0, 2.74, 0], yaw: 0, pitch: 0, distance: 8.9 },
  // Nothing outside the box: all the light comes from the panel.
  environment: { sun: [0, 0, 0], sky: 0 },
  materials: {
    white: { baseColor: [0.725, 0.71, 0.68] },
    red: { baseColor: [0.63, 0.065, 0.05] },
    green: { baseColor: [0.14, 0.45, 0.091] },
    // Bitterli's panel is (17, 12, 4), which is strongly yellow. A camera would
    // correct for that (white balance) and this renderer doesn't, so this is
    // nearer white, to let the bounced colors show on the white walls.
    panel: { baseColor: [0, 0, 0], emission: { color: [1, 0.9, 0.72], strength: 20 } },
  },
  spheres: [],
  boxes: [
    wall([RED_WALL, -WALL, 0], [-WALL, 0, DEPTH + WALL], 'white'), // floor
    wall([RED_WALL, HEIGHT, 0], [-WALL, HEIGHT + WALL, DEPTH + WALL], 'white'), // ceiling
    wall([RED_WALL, 0, DEPTH], [0, HEIGHT, DEPTH + WALL], 'white'), // back wall
    wall([RED_WALL, -WALL, 0], [RED_WALL + WALL, HEIGHT + WALL, DEPTH + WALL], 'red'),
    wall([0, -WALL, 0], [-WALL, HEIGHT + WALL, DEPTH + WALL], 'green'),
    // Only its underside shows, so it stands proud of the ceiling by 0.2 mm of
    // Cornell's, and its edges add next to no light of their own.
    wall([213, HEIGHT - 0.2, 227], [343, HEIGHT + 0.2, 332], 'panel'),
    blockBox(SHORT_BLOCK),
    blockBox(TALL_BLOCK),
  ],
};
