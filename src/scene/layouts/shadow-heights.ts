import type { Scene, Sphere } from '../scene.ts';

// Balls at increasing heights, for comparing their shadows. The higher a ball
// is, the softer its shadow's edge (the sun's size blurs it by about 1 cm per
// meter) and the fainter the soft sky shadow beneath it.
//
// The sun starts in the +x direction, so shadows fall toward -x. The row runs
// along z, so no ball's shadow lands on another.
const RADIUS = 0.35;
const HEIGHTS = [0, 0.3, 0.8, 1.6, 3.2]; // gap under each ball, in meters
const row: Sphere[] = HEIGHTS.map((height, i) => ({
  center: [0, height + RADIUS, 3 - 1.5 * i],
  radius: RADIUS,
  material: 'clay',
}));

export const shadowHeights: Scene = {
  name: 'shadow-heights',
  // Far and low enough to keep the orange ball and its shadow in view at any
  // slider height.
  camera: { target: [-1.5, 2.2, 0], yaw: 1, pitch: 0.3, distance: 15 },
  materials: {
    // Low-contrast squares: shadows stay easy to see, and the squares
    // (1 m wide) give a sense of scale.
    floor: { kind: 'checker', a: [0.75, 0.75, 0.75], b: [0.62, 0.62, 0.62], cellSize: 1 },
    clay: { kind: 'diffuse', albedo: [0.8, 0.8, 0.8] },
    orange: { kind: 'diffuse', albedo: [0.9, 0.35, 0.05] },
  },
  ground: 'floor',
  // The orange ball stands in front of the row, nearer the camera.
  spheres: [...row, { center: [2.5, 1.5, -1], radius: 0.5, material: 'orange' }],
  sliders: [{ label: 'Orange ball height', sphere: HEIGHTS.length, max: 6 }],
};
