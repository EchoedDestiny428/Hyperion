import type { Scene, Sphere } from '../scene.ts';

// Beads marching away from the camera along the ground, each farther than the
// last. The far ones are smaller than a pixel, so with one sample per pixel
// they blink in and out as the camera moves.
const BEAD_RADIUS = 0.04;
const BEAD_DISTANCES = [2, 3, 4.5, 6.5, 9, 12.5, 17, 23, 31, 42, 56, 75];
const beads: Sphere[] = BEAD_DISTANCES.map((distance) => ({
  center: [-1.2, BEAD_RADIUS, -distance],
  radius: BEAD_RADIUS,
  material: 'orange',
}));

// A scene full of the things anti-aliasing fixes, for comparing sample counts
// (Layers panel → Anti-aliasing). Untick "Distance fade" to see the horizon
// at its worst.
export const aliasingTest: Scene = {
  name: 'aliasing-test',
  // Low and looking along the ground, so the checkerboard stretches to the horizon.
  camera: { target: [0, 0.8, -2], yaw: 0.25, pitch: 0.12, distance: 7 },
  materials: {
    // Small, high-contrast squares: in the distance many fit in one pixel,
    // which makes moiré (false wavy patterns) without anti-aliasing.
    fineChecker: { kind: 'checker', a: [0.9, 0.9, 0.9], b: [0.02, 0.02, 0.02], cellSize: 0.25 },
    chrome: { kind: 'mirror', tint: [0.95, 0.95, 0.95] },
    charcoal: { kind: 'diffuse', albedo: [0.02, 0.02, 0.025] },
    orange: { kind: 'diffuse', albedo: [0.9, 0.35, 0.05] },
  },
  ground: 'fineChecker',
  spheres: [
    // A curved mirror squeezes the checkerboard into even finer stripes.
    { center: [1.6, 1, -1], radius: 1, material: 'chrome' },
    // A black ball floating against the bright sky: the clearest stair-stepped edge.
    { center: [-0.5, 2.6, -4], radius: 0.7, material: 'charcoal' },
    ...beads,
  ],
};
