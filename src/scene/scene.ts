import type { Orbit } from '../camera/orbit.ts';
import type { Vec3 } from '../math/vec3.ts';

// A scene layout: the materials, the objects, and where the camera starts.
// Layouts are plain data (see layouts/); packScene() turns one into the bytes
// tracer.wgsl reads, so the same shader can draw any layout.

// What a surface does with light. Each kind has its own fields, and
// TypeScript checks that a material has exactly the fields of its kind.
export type Material =
  | { kind: 'diffuse'; albedo: Vec3 } // matte: lit by the sun, can be in shadow
  | { kind: 'mirror'; tint: Vec3 } // perfect reflection; tint is how much of each color it reflects
  | { kind: 'checker'; a: Vec3; b: Vec3; cellSize: number }; // matte squares of two colors, cellSize meters wide

export interface Sphere {
  center: Vec3;
  radius: number;
  material: string; // a key of Scene.materials
}

export interface Scene {
  name: string; // shown in the scene menu and used in ?scene=
  camera: Orbit; // the starting view
  materials: Record<string, Material>;
  ground: string; // material of the ground plane (y = 0)
  spheres: Sphere[];
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

// The number the shader uses for each kind. Must match the KIND_* constants
// in tracer.wgsl; scene.test.ts checks that.
export const MATERIAL_KIND: Record<Material['kind'], number> = { diffuse: 0, mirror: 1, checker: 2 };

// Byte sizes of the WGSL structs. A struct containing a vec3f is aligned to
// 16 bytes, so Sphere's 20 bytes of fields round up to 32.
// https://www.w3.org/TR/WGSL/#alignment-and-size
//
//   Sphere     slot 0..2 center   3 radius   4 material (u32)   5..7 (padding)
//   Material   slot 0..2 colorA   3 kind (u32)   4..6 colorB   7 cellSize
//   SceneInfo  slot 0 sphereCount (u32)   1 groundMaterial (u32)   2..3 (padding)
export const SPHERE_BYTES = 32;
export const MATERIAL_BYTES = 32;
export const SCENE_INFO_BYTES = 16;

export interface PackedScene {
  info: ArrayBuffer; // struct SceneInfo, for a uniform buffer
  spheres: ArrayBuffer; // array<Sphere>, for a storage buffer
  materials: ArrayBuffer; // array<Material>, for a storage buffer
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

  // Each struct mixes f32 and u32 fields, so each buffer gets two views of
  // the same bytes: one for writing floats, one for writing integers.
  const info = new ArrayBuffer(SCENE_INFO_BYTES);
  const infoInts = new Uint32Array(info);
  infoInts[0] = scene.spheres.length;
  infoInts[1] = materialIndex(scene.ground);

  const materials = new ArrayBuffer(MATERIAL_BYTES * materialEntries.length);
  const materialFloats = new Float32Array(materials);
  const materialInts = new Uint32Array(materials);
  materialEntries.forEach(([, material], i) => {
    const base = (i * MATERIAL_BYTES) / 4; // in 4-byte slots
    materialInts[base + 3] = MATERIAL_KIND[material.kind];
    switch (material.kind) {
      case 'diffuse':
        materialFloats.set(material.albedo, base);
        break;
      case 'mirror':
        materialFloats.set(material.tint, base);
        break;
      case 'checker':
        materialFloats.set(material.a, base);
        materialFloats.set(material.b, base + 4);
        materialFloats[base + 7] = material.cellSize;
        break;
    }
  });

  // A storage buffer binding can't be smaller than one array element, so an
  // empty scene still gets one unused slot; sphereCount says how many are real.
  // https://www.w3.org/TR/webgpu/#dictdef-gpubufferbindinglayout
  const spheres = new ArrayBuffer(SPHERE_BYTES * Math.max(scene.spheres.length, 1));
  const sphereFloats = new Float32Array(spheres);
  const sphereInts = new Uint32Array(spheres);
  scene.spheres.forEach((sphere, i) => {
    const base = (i * SPHERE_BYTES) / 4;
    sphereFloats.set(sphere.center, base);
    sphereFloats[base + 3] = sphere.radius;
    sphereInts[base + 4] = materialIndex(sphere.material);
  });

  return { info, spheres, materials };
}
