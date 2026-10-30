import type { Box, Scene, Sphere } from '../scene.ts';

// Late at night after rain: a bright moon, a neon sign floating in the sky as
// the main light, puddles on the ground, and a field of small mirror balls
// that each reflect the whole scene.

// A 6 × 6 grid of small mirror balls resting on the ground.
const BALL_RADIUS = 0.12;
const balls: Sphere[] = [];
for (let row = 0; row < 6; row++) {
  for (let column = 0; column < 6; column++) {
    balls.push({
      center: [1.2 + column * 0.45, BALL_RADIUS, -0.6 + row * 0.45],
      radius: BALL_RADIUS,
      material: 'chrome',
    });
  }
}

// Square puddles: very thin boxes lying on the ground. Their tops sit 4 mm
// above it, so rays meet the puddle before the ground beneath.
const puddle = (x: number, z: number, side: number, turn: number): Box => ({
  center: [x, 0.002, z],
  size: [side, 0.004, side],
  rotation: [0, turn, 0],
  material: 'puddle',
});

export const neonNight: Scene = {
  name: 'neon-night',
  camera: { target: [0.6, 1, 0], yaw: 0.45, pitch: 0.3, distance: 9 },
  // A bright moon stands in for the sun: a fifth as bright as daylight and a
  // little blue, in a sky about 1/80 as bright as day.
  environment: { sun: [0.26, 0.305, 0.445], sky: 0.012 },
  materials: {
    // Wet asphalt: grey, mostly matte, with a faint mirror sheen.
    asphalt: { kind: 'diffuse', albedo: [0.32, 0.32, 0.33], reflectivity: 0.02 },
    // Almost no green: very bright light washes out toward white on screen
    // (as neon does in photos), and any green would make it pale.
    neon: { kind: 'diffuse', albedo: [0.05, 0.05, 0.05], emission: { color: [1, 0.01, 0.5], strength: 16 } },
    puddle: { kind: 'mirror', tint: [0.6, 0.62, 0.68] },
    chrome: { kind: 'mirror', tint: [0.9, 0.9, 0.92] },
  },
  ground: 'asphalt',
  spheres: balls,
  boxes: [
    // The neon sign, tilted so it isn't lined up with anything.
    { center: [-1, 3.2, -1.5], size: [2.4, 0.35, 0.35], rotation: [0, 25, 8], material: 'neon' },
    // From the starting camera, the sign's reflection falls on the first
    // puddle. The others reflect the night sky, so they look dark.
    puddle(1.3, 2.8, 1.5, -20),
    puddle(-1.6, 1.2, 1.2, 15),
    puddle(-0.4, -0.8, 1.4, 40),
  ],
};
