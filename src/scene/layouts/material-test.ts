import type { Scene, Sphere } from '../scene.ts';

// Materials side by side, for checking how each one treats light. The balls
// run from matte to metal along a dark polished floor.
const RADIUS = 0.6;
const row: Sphere[] = ['matte', 'polished', 'gem', 'gold', 'chrome'].map((material, i) => ({
  center: [(i - 2) * 1.5, RADIUS, 0],
  radius: RADIUS,
  material,
}));

export const materialTest: Scene = {
  name: 'material-test',
  camera: { target: [0, 0.5, 0], yaw: 0, pitch: 0.16, distance: 8 },
  materials: {
    // Nearly black, so its reflection is all you see. The Fresnel effect shows
    // as a floor that's dark at your feet and a mirror toward the horizon.
    floor: { baseColor: [0.02, 0.02, 0.025], roughness: 0 },
    // The same red three ways. Polishing adds a reflection that's faint in the
    // middle of the ball and strong at its edge; a high index of refraction
    // (2.4 is diamond) makes it stronger everywhere.
    matte: { baseColor: [0.55, 0.06, 0.05] },
    polished: { baseColor: [0.55, 0.06, 0.05], roughness: 0 },
    gem: { baseColor: [0.55, 0.06, 0.05], roughness: 0, ior: 2.4 },
    // Metals are tinted by their color head-on and turn white at the edge.
    gold: { baseColor: [1.0, 0.78, 0.34], metallic: 1, roughness: 0 },
    chrome: { baseColor: [0.95, 0.95, 0.95], metallic: 1, roughness: 0 },
  },
  ground: 'floor',
  spheres: row,
};
