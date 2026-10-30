import type { Orbit } from '../camera/orbit.ts';
import { IDENTITY, rotationFromDegrees } from '../math/mat3.ts';
import type { Vec3 } from '../math/vec3.ts';

// A scene layout: the materials, the objects, the light, and where the
// camera starts. Layouts are plain data (see layouts/); packScene() turns one
// into the bytes tracer.wgsl reads, so the same shader can draw any layout.

// Light a surface gives off by itself. Strength is in the same units as the
// sky: 1 is about as bright as the daytime sky near the horizon.
export interface Emission {
  color: Vec3;
  strength: number;
}

// What a surface does with light. Each kind has its own fields, and
// TypeScript checks that a material has exactly the fields of its kind.
// Any material can also glow (`emission`), which makes it a light source.
export type Material = (
  | {
      kind: 'diffuse'; // matte: lit by the sun, can be in shadow
      albedo: Vec3;
      reflectivity?: number; // 0..1: how much reflects like a mirror coat; the rest is matte
    }
  | { kind: 'mirror'; tint: Vec3 } // perfect reflection; tint is how much of each color it reflects
  | {
      kind: 'checker'; // matte squares of two colors, cellSize meters wide
      a: Vec3;
      b: Vec3;
      cellSize: number;
      reflectivity?: number;
    }
) & { emission?: Emission };

export interface Sphere {
  center: Vec3;
  radius: number;
  material: string; // a key of Scene.materials
}

export interface Box {
  center: Vec3;
  size: Vec3; // width (x), height (y) and depth (z) in meters, before rotating
  rotation?: Vec3; // degrees about x, then y, then z
  material: string;
}

// The light that comes from outside the scene.
export interface Environment {
  sun: Vec3; // the sun's color times its brightness
  sky: number; // multiplies the sky's brightness: 1 is daytime
}

export const DAYLIGHT: Environment = { sun: [1.6, 1.52, 1.36], sky: 1 };

export interface Scene {
  name: string; // shown in the scene menu and used in ?scene=
  camera: Orbit; // the starting view
  materials: Record<string, Material>;
  ground?: string; // material of the endless ground plane (y = 0); none if left out
  spheres: Sphere[];
  boxes?: Box[];
  environment?: Environment; // DAYLIGHT if left out
  sliders?: HeightSlider[]; // shown under the Scene menu while this scene is picked
}

// A slider that lifts one sphere off the ground.
export interface HeightSlider {
  label: string;
  sphere: number; // index into spheres
  max: number; // the most it can be lifted, in meters
}

// The gap between the ground and the bottom of a sphere.
export function heightAboveGround(sphere: Sphere): number {
  return sphere.center[1] - sphere.radius;
}

// A copy of the scene with one sphere moved to a new height. A new object,
// so the renderer notices the change, uploads it and restarts accumulation.
export function withSphereHeight(scene: Scene, index: number, height: number): Scene {
  return {
    ...scene,
    spheres: scene.spheres.map((sphere, i) =>
      i === index ? { ...sphere, center: [sphere.center[0], height + sphere.radius, sphere.center[2]] } : sphere,
    ),
  };
}

// The numbers the shader uses. Must match the KIND_*, LIGHT_* and NO_GROUND
// constants in tracer.wgsl; scene.test.ts checks that.
export const MATERIAL_KIND: Record<Material['kind'], number> = { diffuse: 0, mirror: 1, checker: 2 };
export const LIGHT_KIND = { sphere: 0, box: 1 } as const;
export const NO_GROUND = 0xffffffff;

// Byte sizes of the WGSL structs. A vec3f is aligned to 16 bytes, so each one
// leaves a 4-byte slot that holds a single value. A mat3x3f is three vec3f
// columns, each padded to 16 bytes. https://www.w3.org/TR/WGSL/#alignment-and-size
//
//   SceneInfo  slot 0 sphereCount  1 boxCount  2 lightCount  3 groundMaterial (all u32)
//              4..6 sunColor  7 skyStrength
//   Sphere     slot 0..2 center  3 radius  4 material (u32)  5..7 (padding)
//   Box        slot 0..2 center  3 material (u32)  4..6 halfSize  7 (padding)
//              8..10, 12..14, 16..18 rotation columns  11, 15, 19 (padding)
//   Material   slot 0..2 colorA  3 kind (u32)  4..6 colorB  7 cellSize
//              8..10 emission (color × strength)  11 reflectivity
//   Light      slot 0 kind (u32)  1 index (u32)  2 cdf  3 probability
export const SCENE_INFO_BYTES = 32;
export const SPHERE_BYTES = 32;
export const BOX_BYTES = 80;
export const MATERIAL_BYTES = 48;
export const LIGHT_BYTES = 16;

export interface PackedScene {
  info: ArrayBuffer; // struct SceneInfo, for a uniform buffer
  spheres: ArrayBuffer; // array<Sphere>, for a storage buffer
  boxes: ArrayBuffer; // array<Box>
  materials: ArrayBuffer; // array<Material>
  lights: ArrayBuffer; // array<Light>: the glowing objects, for light sampling
}

export function packScene(scene: Scene): PackedScene {
  // The shader refers to a material by its position in the array, so names
  // become indices here. A misspelled name fails now, not as a wrong color.
  const materialEntries = Object.entries(scene.materials);
  const materialIndex = (name: string): number => {
    const index = materialEntries.findIndex(([key]) => key === name);
    if (index < 0) throw new Error(`Scene "${scene.name}" uses material "${name}" but doesn't define it`);
    return index;
  };
  const boxes = scene.boxes ?? [];
  for (const box of boxes) {
    if (!box.size.every((s) => s > 0)) {
      throw new Error(`Scene "${scene.name}" has a box of size ${box.size}; every side must be more than 0`);
    }
  }
  const lights = findLights(scene, boxes);
  const environment = scene.environment ?? DAYLIGHT;

  // Each struct mixes f32 and u32 fields, so each buffer gets two views of
  // the same bytes: one for writing floats, one for writing integers.
  const info = new ArrayBuffer(SCENE_INFO_BYTES);
  const infoFloats = new Float32Array(info);
  const infoInts = new Uint32Array(info);
  infoInts[0] = scene.spheres.length;
  infoInts[1] = boxes.length;
  infoInts[2] = lights.length;
  infoInts[3] = scene.ground === undefined ? NO_GROUND : materialIndex(scene.ground);
  infoFloats.set(environment.sun, 4);
  infoFloats[7] = environment.sky;

  const materials = new ArrayBuffer(MATERIAL_BYTES * Math.max(materialEntries.length, 1));
  const materialFloats = new Float32Array(materials);
  const materialInts = new Uint32Array(materials);
  materialEntries.forEach(([, material], i) => {
    const base = (i * MATERIAL_BYTES) / 4; // in 4-byte slots
    materialInts[base + 3] = MATERIAL_KIND[material.kind];
    switch (material.kind) {
      case 'diffuse':
        materialFloats.set(material.albedo, base);
        materialFloats[base + 11] = material.reflectivity ?? 0;
        break;
      case 'mirror':
        materialFloats.set(material.tint, base);
        break;
      case 'checker':
        materialFloats.set(material.a, base);
        materialFloats.set(material.b, base + 4);
        materialFloats[base + 7] = material.cellSize;
        materialFloats[base + 11] = material.reflectivity ?? 0;
        break;
    }
    materialFloats.set(radiance(material), base + 8);
  });

  // A storage buffer binding can't be smaller than one array element, so an
  // empty list still gets one unused slot; the counts in SceneInfo say how
  // many are real. https://www.w3.org/TR/webgpu/#dictdef-gpubufferbindinglayout
  const spheres = new ArrayBuffer(SPHERE_BYTES * Math.max(scene.spheres.length, 1));
  const sphereFloats = new Float32Array(spheres);
  const sphereInts = new Uint32Array(spheres);
  scene.spheres.forEach((sphere, i) => {
    const base = (i * SPHERE_BYTES) / 4;
    sphereFloats.set(sphere.center, base);
    sphereFloats[base + 3] = sphere.radius;
    sphereInts[base + 4] = materialIndex(sphere.material);
  });

  const boxBuffer = new ArrayBuffer(BOX_BYTES * Math.max(boxes.length, 1));
  const boxFloats = new Float32Array(boxBuffer);
  const boxInts = new Uint32Array(boxBuffer);
  boxes.forEach((box, i) => {
    const base = (i * BOX_BYTES) / 4;
    boxFloats.set(box.center, base);
    boxInts[base + 3] = materialIndex(box.material);
    boxFloats.set(
      box.size.map((s) => s / 2),
      base + 4,
    );
    const [x, y, z] = box.rotation ? rotationFromDegrees(box.rotation) : IDENTITY;
    boxFloats.set(x, base + 8);
    boxFloats.set(y, base + 12);
    boxFloats.set(z, base + 16);
  });

  const lightBuffer = new ArrayBuffer(LIGHT_BYTES * Math.max(lights.length, 1));
  const lightFloats = new Float32Array(lightBuffer);
  const lightInts = new Uint32Array(lightBuffer);
  let cdf = 0;
  lights.forEach((light, i) => {
    const base = (i * LIGHT_BYTES) / 4;
    cdf += light.probability;
    lightInts[base] = LIGHT_KIND[light.kind];
    lightInts[base + 1] = light.index;
    lightFloats[base + 2] = i === lights.length - 1 ? 1 : cdf; // exactly 1 at the end, despite rounding
    lightFloats[base + 3] = light.probability;
  });

  return { info, spheres, boxes: boxBuffer, materials, lights: lightBuffer };
}

// The light a material gives off: color × strength, or black.
function radiance(material: Material): Vec3 {
  const e = material.emission;
  return e ? [e.color[0] * e.strength, e.color[1] * e.strength, e.color[2] * e.strength] : [0, 0, 0];
}

export interface LightEntry {
  kind: keyof typeof LIGHT_KIND;
  index: number; // into spheres or boxes
  probability: number; // of being picked for a shadow ray
}

// Every glowing object, with how often the path tracer should aim shadow
// rays at it: in proportion to the total light it gives off (brightness ×
// surface area), so a big bright panel gets more rays than a dim speck.
export function findLights(scene: Scene, boxes: readonly Box[] = scene.boxes ?? []): LightEntry[] {
  // Perceived brightness of a color (Rec. 709 luminance weights).
  const brightness = (name: string): number => {
    const material = scene.materials[name];
    const [r, g, b] = material ? radiance(material) : [0, 0, 0];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const found: { kind: LightEntry['kind']; index: number; power: number }[] = [];
  scene.spheres.forEach((sphere, index) => {
    const power = brightness(sphere.material) * 4 * Math.PI * sphere.radius ** 2;
    if (power > 0) found.push({ kind: 'sphere', index, power });
  });
  boxes.forEach((box, index) => {
    const [w, h, d] = box.size;
    const power = brightness(box.material) * 2 * (w * h + h * d + w * d);
    if (power > 0) found.push({ kind: 'box', index, power });
  });
  const total = found.reduce((sum, light) => sum + light.power, 0);
  return found.map(({ kind, index, power }) => ({ kind, index, probability: power / total }));
}
