import type { Material, Scene, Sphere } from '../scene.ts';

// Materials side by side, for checking how each one treats light. Three rows of
// balls stand on a polished checkerboard, with roughness rising from left to
// right. Going away from the camera: glass, red plastic, gold.
const RADIUS = 0.6;
const ROUGHNESS = [0, 0.1, 0.25, 0.45, 0.7, 1];
const ball = (column: number, row: number, material: string): Sphere => ({
  center: [(column - 2.5) * 1.5, RADIUS, 2.2 - row * 2.2],
  radius: RADIUS,
  material,
});

const RED = [0.55, 0.06, 0.05] as const;
const GOLD = [1.0, 0.78, 0.34] as const;

// A named material for each roughness, such as plastic2 for ROUGHNESS[2].
const rowOf = (name: string, material: Omit<Material, 'roughness'>): Record<string, Material> =>
  Object.fromEntries(ROUGHNESS.map((roughness, i) => [`${name}${i}`, { ...material, roughness }]));

export const materialTest: Scene = {
  name: 'material-test',
  camera: { target: [0, 0.4, -0.6], yaw: 0, pitch: 0.34, distance: 11 },
  materials: {
    // Dark squares show its reflection best: nearly black at your feet and a
    // mirror toward the horizon (the Fresnel effect). The squares give the
    // glass something to bend.
    floor: { baseColor: { a: [0.02, 0.02, 0.025], b: [0.3, 0.3, 0.32], cellSize: 1 }, roughness: 0 },
    ...rowOf('glass', { baseColor: [1, 1, 1], transmission: 1 }),
    ...rowOf('plastic', { baseColor: [...RED] }),
    ...rowOf('metal', { baseColor: [...GOLD], metallic: 1 }),
    // Polished, with a high index of refraction (2.4 is diamond).
    gem: { baseColor: [1, 1, 1], transmission: 1, roughness: 0, ior: 2.4 },
    // A share of each: half gold, half red plastic; half glass, half red plastic.
    halfMetal: { baseColor: [...GOLD], metallic: 0.5, roughness: 0.25 },
    halfGlass: { baseColor: [...RED], transmission: 0.5, roughness: 0.1 },
    tintedGlass: { baseColor: [0.35, 0.8, 0.5], transmission: 1, roughness: 0 },
  },
  ground: 'floor',
  spheres: [
    ...ROUGHNESS.map((_, i) => ball(i, 0, `glass${i}`)),
    ...ROUGHNESS.map((_, i) => ball(i, 1, `plastic${i}`)),
    ...ROUGHNESS.map((_, i) => ball(i, 2, `metal${i}`)),
    // A short front row of the special cases.
    ...['gem', 'tintedGlass', 'halfGlass', 'halfMetal'].map((name, i) => ball(i + 1, -1, name)),
  ],
};
