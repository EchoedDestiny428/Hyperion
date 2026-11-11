import { type Box, type Scene, boxBetween as between } from '../scene.ts';

// A small stone plaza for testing how the image holds up while the camera
// moves (C2's temporal steps). Orbiting it sweeps each of these across the
// screen, and each one shows one way that can go wrong:
// - a colonnade in front of a wall: as the camera moves, strips of wall keep
//   coming out from behind the columns (disocclusion) and must start clean;
// - paving with fine grout lines: reading the last frame between pixels
//   blurs fine detail, and thin lines show it first;
// - a steel mirror and a chrome ball: reflections should slide like the real
//   thing, not smear;
// - a lantern: a small, very bright edge moving against shade, the hardest
//   edge to keep free of trails;
// - a pergola with a wall on its sunny side: the shade under it is lit only
//   by light bouncing off the plaza, the noisiest light there is, which is
//   what keeping samples from frame to frame is for.
//
// All in meters, with y up and the ground at y = 0. A low sun, 22° up, from
// the +x side and behind the starting view, casts shadows 2.5 m long for
// every meter of height, angled toward the camera.

const HEIGHT = 2.4; // of the wall, the columns and the pergola

// The garden wall, facing the sun, with a colonnade 1.2 m in front of it.
// The columns' shadows fall across the gap and climb the wall.
const COLONNADE_X = -3.8;
const COLUMN = 0.26;
const colonnade: Box[] = [
  between([-5.3, 0, -5.6], [-5, HEIGHT + 0.2, 5.6], 'sandstone'),
  between([COLONNADE_X - 0.18, HEIGHT, -4.4], [COLONNADE_X + 0.18, HEIGHT + 0.22, 4.4], 'whiteStone'),
];
for (let z = -3.9; z <= 3.9; z += 1.56) {
  colonnade.push(
    between([COLONNADE_X - COLUMN / 2, 0, z - COLUMN / 2], [COLONNADE_X + COLUMN / 2, HEIGHT, z + COLUMN / 2], 'whiteStone'),
  );
}

// The pergola: a timber roof on four posts, closed by walls on the two sides
// the low sun comes from, so the bench under it is in shade. A lantern hangs
// from the roof on a thin rod (thin things flicker when the camera moves).
const PERGOLA = { left: 1, right: 4, far: -4, near: -1 };
const POST = 0.14;
const pergola: Box[] = [
  between([PERGOLA.left, HEIGHT, PERGOLA.far], [PERGOLA.right, HEIGHT + 0.12, PERGOLA.near], 'timber'),
  between([PERGOLA.right - 0.15, 0, PERGOLA.far], [PERGOLA.right, HEIGHT, PERGOLA.near], 'sandstone'),
  between([PERGOLA.left, 0, PERGOLA.far], [PERGOLA.right, HEIGHT, PERGOLA.far + 0.15], 'sandstone'),
  between([1.6, 0, -3.65], [3.3, 0.42, -3.25], 'timber'),
  between([2.36, 1.72, -2.64], [2.64, 2, -2.36], 'lantern'),
  between([2.49, 2, -2.51], [2.51, HEIGHT, -2.49], 'darkMetal'),
];
for (const x of [PERGOLA.left, PERGOLA.right - POST]) {
  for (const z of [PERGOLA.far, PERGOLA.near - POST]) {
    pergola.push(between([x, 0, z], [x + POST, HEIGHT, z + POST], 'timber'));
  }
}

// A polished steel slab standing on a low base, off to the right of the
// starting view and turned to show the middle of the plaza.
const MIRROR_TURN: [number, number, number] = [0, -50, 0];
const mirror: Box[] = [
  { center: [5.2, 0.06, 1.5], size: [1.7, 0.12, 0.4], rotation: MIRROR_TURN, material: 'whiteStone' },
  { center: [5.2, 1.22, 1.5], size: [1.4, 2.2, 0.06], rotation: MIRROR_TURN, material: 'steelMirror' },
];

// Planters with round shrubs, for curved edges and a little color.
const planters: Box[] = [
  between([-2.6, 0, 3.8], [-1.8, 0.5, 4.6], 'terracotta'),
  between([-1.9, 0, -5.2], [-1.1, 0.5, -4.4], 'terracotta'),
];

export const motionTest: Scene = {
  name: 'motion-test',
  // From the open side, so the colonnade recedes on the left, the pergola's
  // shade is in view on the right, and the sun comes from the side.
  camera: { target: [0, 1, -0.5], yaw: 0.3, pitch: 0.2, distance: 10 },
  // Darker than real pale stone. With no exposure control, light bouncing
  // between pale surfaces under a bright sky washes the whole view out (the
  // dreamspace's tile has the same note).
  materials: {
    paving: {
      baseColor: { tile: [0.37, 0.35, 0.32], grout: [0.22, 0.21, 0.19], cellSize: 0.6, groutWidth: 0.02 },
      roughness: 0.8,
    },
    sandstone: {
      baseColor: { tile: [0.55, 0.44, 0.32], grout: [0.4, 0.34, 0.27], cellSize: 0.4, groutWidth: 0.012 },
      roughness: 0.9,
    },
    whiteStone: { baseColor: [0.62, 0.6, 0.56], roughness: 0.7 },
    timber: { baseColor: [0.42, 0.28, 0.18], roughness: 0.8 },
    terracotta: { baseColor: [0.62, 0.32, 0.2], roughness: 0.9 },
    shrub: { baseColor: [0.16, 0.3, 0.11] },
    darkMetal: { baseColor: [0.12, 0.12, 0.12], metallic: 1, roughness: 0.4 },
    steelMirror: { baseColor: [0.9, 0.9, 0.9], metallic: 1, roughness: 0 },
    chrome: { baseColor: [0.95, 0.95, 0.95], metallic: 1, roughness: 0 },
    // Warm, like a candle-colored bulb, and bright enough to light the bench.
    lantern: { baseColor: [0.05, 0.05, 0.05], emission: { color: [1, 0.78, 0.5], strength: 6 } },
  },
  ground: 'paving',
  spheres: [
    { center: [-1, 1.25, 1.8], radius: 0.45, material: 'chrome' },
    { center: [-2.2, 0.85, 4.2], radius: 0.42, material: 'shrub' },
    { center: [-1.5, 0.85, -4.8], radius: 0.42, material: 'shrub' },
  ],
  boxes: [
    ...colonnade,
    ...pergola,
    ...mirror,
    ...planters,
    // The chrome ball's plinth.
    between([-1.3, 0, 1.5], [-0.7, 0.8, 2.1], 'whiteStone'),
  ],
  // Bright stone in full sun washes out at the usual exposure.
  exposure: -0.5,
  // Late afternoon: a low, warm sun, from the side and behind the view.
  environment: { sun: [1.7, 1.42, 1.08], sky: 0.7, sunElevation: 22, sunAzimuth: -40 },
};
