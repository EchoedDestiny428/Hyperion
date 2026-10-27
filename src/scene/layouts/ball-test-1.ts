import type { Scene } from '../scene.ts';

// The C0 test scene: five spheres on a checkerboard. The chrome and gold balls
// reflect each other, which exercises multiple mirror bounces.
export const ballTest1: Scene = {
  name: 'ball-test-1',
  camera: { target: [0, 0.8, 0], yaw: 0.6, pitch: 0.35, distance: 9 },
  materials: {
    checker: { kind: 'checker', a: [0.8, 0.8, 0.8], b: [0.12, 0.12, 0.12], cellSize: 1 },
    red: { kind: 'diffuse', albedo: [0.75, 0.05, 0.04] },
    blue: { kind: 'diffuse', albedo: [0.03, 0.08, 0.6] },
    chrome: { kind: 'mirror', tint: [0.95, 0.95, 0.95] },
    gold: { kind: 'mirror', tint: [1.0, 0.78, 0.34] },
  },
  ground: 'checker',
  spheres: [
    { center: [0, 1, 0], radius: 1, material: 'chrome' },
    { center: [-2.3, 0.7, 0.9], radius: 0.7, material: 'red' },
    { center: [2.1, 0.8, -0.7], radius: 0.8, material: 'gold' },
    { center: [1.0, 0.4, 2.0], radius: 0.4, material: 'blue' },
    { center: [-1.2, 0.5, -2.2], radius: 0.5, material: 'red' },
  ],
};
