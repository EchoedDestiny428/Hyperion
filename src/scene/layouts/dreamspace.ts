import { orbitFromFly } from '../../camera/fly.ts';
import { type Box, type Scene, boxBetween as between } from '../scene.ts';

// A tiled hall with a long pool down the middle, lit by glowing ceiling panels
// and by daylight through a wall of tall windows. It's the first step toward
// the dreamlike space this project is aiming for, and it uses every material.
//
// All in meters. x runs across the hall, z along it, y up, and the deck is at
// y = 0. The room's edges fall on whole tiles, so no tile is cut in half.
const TILE = 0.3;
const HALL = { left: -6, right: 8.1, far: -13.8, near: 6, height: 4.5 };
const POOL = { left: -3.6, right: 3.6, far: -9.9, near: 2.1, depth: 1.2, waterline: -0.12 };
const WALL = 0.6; // thickness of the walls and ceiling
const BOTTOM = -2; // where the floor's boxes end, out of sight

// The sun shines in from +x at about 42°, so light through a window lands
// (height ÷ 0.9) meters into the room. These windows stop 4 m in, on the deck,
// because water blocks shadow rays: sun landing on the pool would be lost.
const SILL = 0.6;
const WINDOW_TOP = 3.6;
const BAY = 3; // one window and one pillar
const PILLAR = 0.6;

// The deck is four boxes around the hole for the pool.
const floor: Box[] = [
  between([HALL.left, BOTTOM, HALL.far], [POOL.left, 0, HALL.near], 'tile'),
  between([POOL.right, BOTTOM, HALL.far], [HALL.right, 0, HALL.near], 'tile'),
  between([POOL.left, BOTTOM, HALL.far], [POOL.right, 0, POOL.far], 'tile'),
  between([POOL.left, BOTTOM, POOL.near], [POOL.right, 0, HALL.near], 'tile'),
];

// The inside of the pool: a bottom, and a thin lining on each side.
const LINING = 0.02;
const lining: Box[] = [
  between([POOL.left, BOTTOM, POOL.far], [POOL.right, -POOL.depth, POOL.near], 'poolTile'),
  between([POOL.left, -POOL.depth, POOL.far], [POOL.left + LINING, 0, POOL.near], 'poolTile'),
  between([POOL.right - LINING, -POOL.depth, POOL.far], [POOL.right, 0, POOL.near], 'poolTile'),
  between([POOL.left, -POOL.depth, POOL.far], [POOL.right, 0, POOL.far + LINING], 'poolTile'),
  between([POOL.left, -POOL.depth, POOL.near - LINING], [POOL.right, 0, POOL.near], 'poolTile'),
];

// The water runs a little way into the pool's walls and floor. If they only
// touched, a ray reaching that surface could hit either one, at random. This
// way it always meets the tile first.
const OVERLAP = 0.05;
const water = between(
  [POOL.left - OVERLAP, -POOL.depth - OVERLAP, POOL.far - OVERLAP],
  [POOL.right + OVERLAP, POOL.waterline, POOL.near + OVERLAP],
  'water',
);

const outerRight = HALL.right + WALL;
const walls: Box[] = [
  between([HALL.left - WALL, BOTTOM, HALL.far - WALL], [HALL.left, HALL.height, HALL.near + WALL], 'tile'),
  between([HALL.left, BOTTOM, HALL.far - WALL], [outerRight, HALL.height, HALL.far], 'tile'),
  between([HALL.left, BOTTOM, HALL.near], [outerRight, HALL.height, HALL.near + WALL], 'tile'),
  between([HALL.left - WALL, HALL.height, HALL.far - WALL], [outerRight, HALL.height + WALL, HALL.near + WALL], 'plaster'),
  // The window wall: a low sill, a beam over the windows, and pillars between.
  between([HALL.right, BOTTOM, HALL.far], [outerRight, SILL, HALL.near], 'tile'),
  between([HALL.right, WINDOW_TOP, HALL.far], [outerRight, HALL.height, HALL.near], 'tile'),
];
for (let z = HALL.far; z < HALL.near; z += BAY) {
  walls.push(between([HALL.right, SILL, z], [outerRight, WINDOW_TOP, Math.min(z + PILLAR, HALL.near)], 'tile'));
}

// Two rows of panels over the pool, sunk just into the ceiling.
const panels: Box[] = [];
for (const x of [-1.8, 1.8]) {
  for (const z of [-8.4, -3.9, 0.6]) {
    panels.push(between([x - 0.9, HALL.height - 0.03, z - 0.6], [x + 0.9, HALL.height + 0.03, z + 0.6], 'panel'));
  }
}

// Columns of brushed metal, standing in the sunlight.
const columns: Box[] = [-10.5, -4.5, 1.5].map((z) =>
  between([5.85, 0, z - 0.15], [6.15, HALL.height, z + 0.15], 'brushedMetal'),
);

export const dreamspace: Scene = {
  name: 'dreamspace',
  // Standing at eye height in a corner of the deck, looking down the hall.
  camera: orbitFromFly({ position: [-4.8, 1.6, 4.8], yaw: -0.3, pitch: -0.08 }, 8),
  cameraMode: 'fly',
  materials: {
    // Darker than real white tile. Light bouncing between surfaces that reflect
    // 80% of it adds up to five times what arrives directly, which fills in
    // every shadow and drowns out the sun, and there's no exposure setting to
    // bring it back down. At 60%, it's two and a half times.
    tile: {
      baseColor: { tile: [0.6, 0.63, 0.62], grout: [0.36, 0.38, 0.38], cellSize: TILE, groutWidth: 0.008 },
      roughness: 0.12,
    },
    poolTile: {
      baseColor: { tile: [0.1, 0.4, 0.44], grout: [0.3, 0.42, 0.44], cellSize: TILE, groutWidth: 0.008 },
      roughness: 0.12,
    },
    plaster: { baseColor: [0.6, 0.6, 0.58] },
    panel: { baseColor: [0.05, 0.05, 0.05], emission: { color: [1, 0.93, 0.82], strength: 3.5 } },
    // A slight green-blue tint, as deep clean water has.
    water: { baseColor: [0.74, 0.93, 0.92], transmission: 1, roughness: 0, ior: 1.33 },
    brushedMetal: { baseColor: [0.75, 0.75, 0.73], metallic: 1, roughness: 0.35 },
    chrome: { baseColor: [0.9, 0.9, 0.92], metallic: 1, roughness: 0 },
    frosted: { baseColor: [1, 1, 1], transmission: 1, roughness: 0.15 },
  },
  spheres: [
    { center: [-4.6, 0.7, -8], radius: 0.7, material: 'chrome' },
    { center: [-4.9, 0.45, 0.6], radius: 0.45, material: 'frosted' },
  ],
  boxes: [...floor, ...lining, water, ...walls, ...panels, ...columns],
};
