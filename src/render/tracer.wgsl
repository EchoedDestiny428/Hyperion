// Two renderers in one shader, picked from the Renderer menu:
// - Whitted (C0): one ray per pixel; at a matte surface, shadow rays toward
//   the sun and each light and a fake "ambient" term; mirrors bounce the ray
//   onward.
// - Path tracer (C1): light really bounces, the sky and glowing objects light
//   the scene, and each sample follows one random path. Many samples averaged
//   (accumulation) give the clean image.
// WGSL spec: https://www.w3.org/TR/WGSL/

// Must match packFrameUniforms() in frame-uniforms.ts. A vec3f is aligned to
// 16 bytes, so a 4-byte value sits in each vec3f's spare 4 bytes.
// https://www.w3.org/TR/WGSL/#alignment-and-size
struct Frame {
  cameraPos: vec3f,
  tanHalfFovY: f32,
  cameraRight: vec3f,
  aspect: f32,
  cameraUp: vec3f,
  time: f32,
  cameraForward: vec3f,
  renderer: u32, // one of RENDERER_*
  resolution: vec2f,
  view: u32, // one of VIEW_*
  sampleIndex: u32, // samples already in the running total; 0 = start over
  maxBounces: u32, // path tracer: the most surfaces one path visits (the Bounces slider)
  exposure: f32, // light is multiplied by this before tone mapping: 2^stops (the Exposure slider)
  cameraMoved: u32, // 1 if the camera moved since the last frame: pixels then find their history where their point was
  maxHistory: f32, // while moving, history counts as at most this many samples; 0 = none (the History slider)
  // The camera the last frame was drawn with, to find where each point was
  // on screen then (its motion vector). The same as above while it's still.
  previousCameraPos: vec3f,
  previousCameraRight: vec3f,
  previousCameraUp: vec3f,
  previousCameraForward: vec3f,
}

@group(0) @binding(0) var<uniform> frame: Frame;

// ---- Renderers and views -------------------------------------------------
// Set from the Renderer panel. Must match RENDERERS and VIEWS in settings.ts
// (settings.test.ts checks).
const RENDERER_WHITTED = 0u;
const RENDERER_PATH = 1u;

// The views other than VIEW_FINAL output false color: display values that
// show one ingredient of the image, not light.
const VIEW_FINAL = 0u;
const VIEW_COLOR = 1u;
const VIEW_NORMALS = 2u;
const VIEW_DISTANCE = 3u;
const VIEW_SUNLIGHT = 4u;
const VIEW_RAYS = 5u;
const VIEW_MOTION = 6u;
const VIEW_HISTORY = 7u;

// ---- Full-screen triangle ------------------------------------------------
// One triangle with corners (-1,-1), (3,-1), (-1,3) covers all of clip space
// (-1..1 on both axes); the GPU clips away the part outside the screen. The
// fragment shader then runs exactly once per pixel. No vertex buffer needed:
// the corners are computed from the vertex index.
@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u)); // (0,0) (2,0) (0,2)
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

// ---- Scene ---------------------------------------------------------------
// The layout comes from the CPU (packScene() in scene/scene.ts), so this one
// shader can draw any scene. These structs must match what packScene() writes.
// https://www.w3.org/TR/WGSL/#alignment-and-size

struct SceneInfo {
  sphereCount: u32,
  boxCount: u32,
  lightCount: u32,
  groundMaterial: u32, // index into materials, or NO_GROUND
  sunColor: vec3f, // the sun's color times its brightness
  skyStrength: f32, // multiplies the sky: 1 is daytime
  sunHeight: f32, // how far up the sun is per unit across: tan(elevation)
  sunAzimuth: f32, // radians around the vertical, from +x toward +z
  // WGSL rounds the struct up to 48 bytes, a multiple of 16.
}

const NO_GROUND = 4294967295u; // 0xffffffff: this scene has no ground plane

struct Sphere {
  center: vec3f,
  radius: f32,
  material: u32, // index into materials
  lightDensity: f32, // the chance per m² of a shadow ray aiming at a point on it; 0 if it doesn't glow
  // WGSL pads this struct from 24 to 32 bytes: a struct holding a vec3f is
  // aligned to 16 bytes, and its size rounds up to match.
}

struct Box {
  center: vec3f,
  material: u32,
  halfSize: vec3f, // half the width, height and depth, before rotating
  lightDensity: f32, // as in Sphere
  rotation: mat3x3f, // columns: where the box's own x, y and z axes point
}

// One material model for every surface, set by numbers. Field order must match
// packScene in scene/scene.ts (scene.test.ts checks).
struct Material {
  colorA: vec3f, // baseColor, a checker's first color, or the tiles' color
  roughness: f32, // 0 polished .. 1 fully rough
  colorB: vec3f, // a checker's second color, or the grout's color
  cellSize: f32, // width of a checker's squares or of tiles in meters; 0 for a plain color
  emission: vec3f, // light it gives off by itself; black for most materials
  metallic: f32, // 0 non-metal .. 1 metal
  ior: f32, // index of refraction
  transmission: f32, // the share of a non-metal's light that passes through
  groutWidth: f32, // width of the lines between tiles in meters; 0 for anything but tiles
}

// The glowing objects, for aiming shadow rays at them. Must match LIGHT_KIND
// in scene/scene.ts.
const LIGHT_SPHERE = 0u;
const LIGHT_BOX = 1u;

struct Light {
  kind: u32, // LIGHT_SPHERE or LIGHT_BOX
  index: u32, // into spheres or boxes
  cdf: f32, // running total of the pick probabilities, ending at 1
  probability: f32, // of this light being picked
}

// A uniform buffer is small and fixed-size. Storage buffers can be large, and
// an array in one needs no fixed length (array<Sphere>, not array<Sphere, 5>),
// so the same shader handles any number of objects.
@group(0) @binding(1) var<uniform> scene: SceneInfo;
@group(0) @binding(2) var<storage, read> spheres: array<Sphere>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;
@group(0) @binding(5) var<storage, read> boxes: array<Box>;
@group(0) @binding(6) var<storage, read> lights: array<Light>;

struct Ray {
  origin: vec3f,
  dir: vec3f, // unit length
}

struct Hit {
  t: f32, // distance along the ray, or NO_HIT
  position: vec3f,
  normal: vec3f, // unit length, pointing out of the surface
  material: u32, // index into materials
  lightDensity: f32, // as in Sphere; 0 for anything that isn't a sampled light
}

const NO_HIT = 1e30;
const NO_OBJECT = 4294967295u; // 0xffffffff: not an index into spheres or boxes
// New rays start this far off the surface. Otherwise rounding error can make
// a ray immediately re-hit the surface it left ("shadow acne").
const EPSILON = 1e-3;
const PI = 3.14159265;

// ---- Intersection --------------------------------------------------------
fn intersectSphere(ray: Ray, sphere: Sphere) -> f32 {
  // Solve |origin + t*dir - center|² = r² for t. Because |dir| = 1 this is
  // t² + 2bt + c = 0 with b = dot(oc, dir), c = |oc|² - r².
  let oc = ray.origin - sphere.center;
  let b = dot(oc, ray.dir);
  let c = dot(oc, oc) - sphere.radius * sphere.radius;
  let discriminant = b * b - c;
  if (discriminant < 0.0) {
    return NO_HIT; // the ray's line misses the sphere entirely
  }
  let root = sqrt(discriminant);
  var t = -b - root; // the nearer of the two intersections
  if (t < EPSILON) {
    t = -b + root; // nearer one is behind us; try the farther one
  }
  if (t < EPSILON) {
    return NO_HIT; // whole sphere is behind the ray
  }
  return t;
}

// The ray in the box's own coordinates, where the box is centered at the
// origin and lined up with the axes: undo the move, then the rotation. A
// rotation matrix's inverse is its transpose, and `v * m` multiplies by the
// transpose.
fn rayInBoxSpace(ray: Ray, box: Box) -> Ray {
  let origin = (ray.origin - box.center) * box.rotation;
  let dir = ray.dir * box.rotation;
  // WGSL doesn't promise that dividing by zero gives infinity, so nudge zero
  // components to a tiny number instead. https://www.w3.org/TR/WGSL/#floating-point-evaluation
  return Ray(origin, select(dir, vec3f(1e-20), abs(dir) < vec3f(1e-20)));
}

fn intersectBox(ray: Ray, box: Box) -> f32 {
  let local = rayInBoxSpace(ray, box);

  // The "slab" test (Kay & Kajiya, 1986). The box is where three slabs
  // overlap, each the space between two parallel planes. Along each axis the
  // ray is inside that slab from tNear to tFar; it's inside the box from the
  // last of the entries to the first of the exits.
  let tA = (-box.halfSize - local.origin) / local.dir;
  let tB = (box.halfSize - local.origin) / local.dir;
  let entries = min(tA, tB);
  let exits = max(tA, tB);
  let tEnter = max(max(entries.x, entries.y), entries.z);
  let tExit = min(min(exits.x, exits.y), exits.z);
  if (tEnter > tExit || tExit < EPSILON) {
    return NO_HIT; // the slabs never overlap along the ray, or the box is behind it
  }
  return select(tEnter, tExit, tEnter < EPSILON); // starting inside: where the ray leaves
}

// The direction of the box's surface where the ray meets it at distance `t`.
// The face hit is the one the point is closest to, relative to the box's size
// along each axis.
fn boxNormal(ray: Ray, box: Box, t: f32) -> vec3f {
  let local = rayInBoxSpace(ray, box);
  let p = local.origin + t * local.dir;
  let q = abs(p) / box.halfSize;
  var n = vec3f(0.0);
  if (q.x >= q.y && q.x >= q.z) {
    n.x = sign(p.x);
  } else if (q.y >= q.z) {
    n.y = sign(p.y);
  } else {
    n.z = sign(p.z);
  }
  return box.rotation * n; // back to world directions
}

fn intersectGround(ray: Ray) -> f32 {
  // The plane y = 0. Only rays heading downward can reach it.
  if (scene.groundMaterial == NO_GROUND || ray.dir.y > -1e-6) {
    return NO_HIT;
  }
  let t = -ray.origin.y / ray.dir.y;
  return select(NO_HIT, t, t > EPSILON);
}

// Rays traced for this pixel's current sample, for VIEW_RAYS. Each pixel's
// run of the shader has its own copy of a `private` variable.
var<private> rayCount: u32;

// What the path tracer's camera sees in this pixel, kept for the denoiser (see
// PixelRecord): the color of the first surface the camera ray hits, and its
// normal (facing the camera) with its distance.
// - In a perfect mirror, the denoiser should smooth the reflected surface, not
//   the mirror, or it would smear the reflection. So it's the surface the
//   mirror shows, as its mirror image: as far away as the reflected path is
//   long, turned the way the mirror shows it (mirrorMatrix), and tinted by
//   the mirror's color. Chrome reflects the color of what it shows.
// - The distance stays NO_HIT where there's nothing to denoise: sky, and
//   glowing surfaces, whose light the camera sees directly, without noise.
// - The distance is negative for a mirror image. A vertical mirror standing
//   on the floor shows the floor in exactly the floor's own plane, facing the
//   same way, so position and facing can't tell the two apart; this does,
//   and the denoiser and reprojection never mix them.
var<private> firstColor: vec3f;
var<private> firstSurface: vec4f;
// Whether the path tracer's camera ray went straight to a light or the sky,
// with nothing in between: see isNoiseFree.
var<private> directGlow: bool;
// How far along the camera ray the first thing it shows is: as firstSurface's
// distance, but also for a glowing surface. NO_HIT for sky. For reprojecting.
var<private> firstDepth: f32;

// Polished metal: the path always reflects off it in one exact direction.
fn isPerfectMirror(material: Material) -> bool {
  return material.metallic >= 1.0 && material.roughness < POLISHED_ROUGHNESS;
}

// The reflection across the plane with unit normal n, as a matrix: I - 2nnᵀ.
// Like the mirror image of a room, the reflected world is the real one turned
// inside out, so the denoiser compares normals the way the mirror shows them.
fn mirrorMatrix(n: vec3f) -> mat3x3f {
  return mat3x3f(
    vec3f(1.0, 0.0, 0.0) - 2.0 * n * n.x,
    vec3f(0.0, 1.0, 0.0) - 2.0 * n * n.y,
    vec3f(0.0, 0.0, 1.0) - 2.0 * n * n.z,
  );
}

// ---- BVH -------------------------------------------------------------------
// A tree of boxes around the objects (built by scene/bvh.ts), so a ray skips
// every object inside a box it misses. Must match packBvh in bvh.ts
// (bvh.test.ts checks the constants).
struct BvhNode {
  boundsMin: vec3f,
  first: u32, // leaf: first entry in bvhItems; inner node: the node after its subtree, for a miss
  boundsMax: vec3f,
  count: u32, // objects in a leaf; 0 for an inner node
}

const BOX_ITEM_BIT = 2147483648u; // 0x80000000: set on bvhItems entries that are boxes

@group(0) @binding(7) var<storage, read> bvhNodes: array<BvhNode>;
@group(0) @binding(8) var<storage, read> bvhItems: array<u32>; // an index into spheres, or into boxes with BOX_ITEM_BIT set

// Where a ray enters a node's box (0 if it starts inside), or NO_HIT if it
// misses it or only reaches it at `limit` or beyond. The same slab test as
// intersectBox, without the turning: these boxes are lined up with the world.
// `inverse` is 1 ÷ the ray's direction, worked out once per ray.
fn nodeEntry(origin: vec3f, inverse: vec3f, node: BvhNode, limit: f32) -> f32 {
  let a = (node.boundsMin - origin) * inverse;
  let b = (node.boundsMax - origin) * inverse;
  let enter = max(max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z)), 0.0);
  let exit = min(min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z)), limit);
  return select(NO_HIT, enter, enter <= exit);
}

// Finds the closest thing the ray hits. The ground plane is endless, so it's
// tested on its own; everything else is found by walking the BVH.
fn intersectScene(ray: Ray) -> Hit {
  rayCount++;
  var hit: Hit;
  hit.t = intersectGround(ray);
  hit.normal = vec3f(0.0, 1.0, 0.0);
  hit.material = scene.groundMaterial;

  // Only remember which object is closest so far. Its normal is worked out
  // once at the end, since a closer object may yet replace it.
  var closestSphere = NO_OBJECT;
  var closestBox = NO_OBJECT;

  if (scene.sphereCount + scene.boxCount > 0u) {
    // WGSL doesn't promise that dividing by zero gives infinity; see rayInBoxSpace.
    let inverse = 1.0 / select(ray.dir, vec3f(1e-20), abs(ray.dir) < vec3f(1e-20));
    // The walk, with the nodes stored depth first (depthFirst in bvh.ts): if
    // the ray reaches a node's box before the closest hit so far, go on to the
    // next node, which is its first child, or test its objects if it's a leaf.
    // If not, skip its whole subtree by following its link. No list of nodes
    // still to visit is needed.
    let nodeCount = arrayLength(&bvhNodes);
    var node = 0u;
    while (node < nodeCount) {
      let current = bvhNodes[node];
      let reached = nodeEntry(ray.origin, inverse, current, hit.t) < hit.t;
      if (reached && current.count > 0u) {
        // A leaf: test its objects.
        for (var k = current.first; k < current.first + current.count; k++) {
          let item = bvhItems[k];
          let index = item & ~BOX_ITEM_BIT;
          if ((item & BOX_ITEM_BIT) != 0u) {
            let t = intersectBox(ray, boxes[index]);
            if (t < hit.t) {
              hit.t = t;
              closestBox = index;
              closestSphere = NO_OBJECT;
            }
          } else {
            let t = intersectSphere(ray, spheres[index]);
            if (t < hit.t) {
              hit.t = t;
              closestSphere = index;
              closestBox = NO_OBJECT;
            }
          }
        }
      }
      // A leaf's next node, or an inner node's first child, comes right after
      // it; a missed inner node's link points past its subtree.
      node = select(node + 1u, current.first, !reached && current.count == 0u);
    }
  }

  hit.position = ray.origin + hit.t * ray.dir;
  if (closestBox != NO_OBJECT) {
    let box = boxes[closestBox];
    hit.normal = boxNormal(ray, box, hit.t);
    hit.material = box.material;
    hit.lightDensity = box.lightDensity;
    if (box.lightDensity > 0.0) {
      // Shadow rays from where this ray started only aim at the faces visible
      // from there (sampleLight), so the same chance is spread over less area.
      // MIS needs this to match, or found light would be counted wrongly.
      let visible = visibleFaceAreas(box.halfSize, pointInBoxSpace(box, ray.origin));
      let seen = visible.x + visible.y + visible.z;
      hit.lightDensity = select(0.0, box.lightDensity * boxSurfaceArea(box.halfSize) / seen, seen > 0.0);
    }
  } else if (closestSphere != NO_OBJECT) {
    let sphere = spheres[closestSphere];
    hit.normal = normalize(hit.position - sphere.center);
    hit.material = sphere.material;
    hit.lightDensity = sphere.lightDensity;
  }
  return hit;
}

// Whether anything blocks the straight line from `position` (on a surface
// with this normal) along `dir` for `distance`.
fn blocked(position: vec3f, normal: vec3f, dir: vec3f, distance: f32) -> bool {
  return intersectScene(Ray(position + normal * EPSILON, dir)).t < distance;
}

// ---- Random numbers ------------------------------------------------------
// GPUs have no built-in random(), and every pixel needs its own unrelated
// numbers. A hash function scrambles an input into a number that looks
// random; seeding it with the pixel and the sample number gives each pixel a
// different sequence, and each sample a different one again.
// PCG hash from Jarzynski & Olano, "Hash Functions for GPU Rendering" (2020):
// https://jcgt.org/published/0009/03/02/
fn pcgHash(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u; // u32 math wraps around on overflow
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

var<private> rngState: u32;

fn seedRandom(pixel: vec2u, sampleNumber: u32) {
  rngState = pcgHash(pixel.x + pcgHash(pixel.y + pcgHash(sampleNumber)));
}

// A hash as a number in [0, 1). Uses the top 24 bits, because an f32 holds 24
// bits exactly; converting all 32 could round up to 1.0.
fn unitFromHash(hash: u32) -> f32 {
  return f32(hash >> 8u) / 16777216.0;
}

fn random() -> f32 {
  rngState = pcgHash(rngState);
  return unitFromHash(rngState);
}

// A random direction, every direction equally likely.
fn randomUnitVector() -> vec3f {
  let z = 1.0 - 2.0 * random(); // uniform height on the sphere gives uniform area
  let r = sqrt(max(0.0, 1.0 - z * z));
  let angle = 2.0 * PI * random();
  return vec3f(r * cos(angle), r * sin(angle), z);
}

// Two directions at right angles to `n` and to each other, so a direction
// chosen around the z axis can be turned to point around `n` instead.
// Duff et al., "Building an Orthonormal Basis, Revisited" (2017):
// https://jcgt.org/published/0006/01/01/
fn perpendiculars(n: vec3f) -> mat2x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat2x3f(vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x), vec3f(b, s + n.y * n.y * a, -n.y));
}

// ---- Sun and sky ---------------------------------------------------------
// The scene sets the sun's color and brightness (scene.sunColor): how much it
// lights a surface facing it, per unit of albedo.
// The sun's real size seen from Earth: about 0.53° across, so 0.27° = 0.00465
// radians from its center to its edge. It sets both the disk in the sky and
// how soft the path tracer's shadows are.
const SUN_ANGULAR_RADIUS = 0.00465;
// The size of the disk as seen from the ground, in steradians (the area of a
// patch on a sphere of radius 1), and so the chance density of a shadow ray
// aimed at the sun going in any one direction across it.
const SUN_SOLID_ANGLE = 2.0 * PI * (1.0 - cos(SUN_ANGULAR_RADIUS));
const SUN_PDF = 1.0 / SUN_SOLID_ANGLE;

fn sunDirection() -> vec3f {
  // Each scene places it (Environment in scene.ts). It can also circle
  // ("Sun moves") to show that shadows are computed live.
  let angle = frame.time * 0.15 + scene.sunAzimuth;
  return normalize(vec3f(cos(angle), scene.sunHeight, sin(angle)));
}

// A random direction toward some point on the sun's disk. Shadow rays aimed
// this way are blocked by an object for some points and not others near a
// shadow's edge, which averages into a soft edge (the penumbra). It widens
// with distance from the object, as real shadows do.
fn sampleSunDirection(toSun: vec3f) -> vec3f {
  // Uniform over the small cone of directions that hit the disk.
  let cosEdge = cos(SUN_ANGULAR_RADIUS);
  let cosTheta = 1.0 - random() * (1.0 - cosEdge);
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  let angle = 2.0 * PI * random();
  let side = perpendiculars(toSun);
  return normalize(side[0] * (cos(angle) * sinTheta) + side[1] * (sin(angle) * sinTheta) + toSun * cosTheta);
}

// The light arriving from direction `dir`. `withSunDisk` adds a painted disk,
// bright enough to read as the sun. The path tracer leaves it out and uses
// sunDisk instead.
fn sky(dir: vec3f, toSun: vec3f, withSunDisk: bool) -> vec3f {
  let horizon = vec3f(0.62, 0.74, 0.9);
  let zenith = vec3f(0.1, 0.27, 0.7);
  var color = mix(horizon, zenith, sqrt(max(dir.y, 0.0))) * scene.skyStrength;
  let towardSun = dot(dir, toSun); // 1 when looking straight at the sun
  if (withSunDisk) {
    let edge = cos(SUN_ANGULAR_RADIUS);
    color += scene.sunColor * 4.0 * smoothstep(edge - 2e-6, edge + 2e-6, towardSun); // the disk
  }
  color += scene.sunColor * 0.15 * pow(max(towardSun, 0.0), 64.0); // glow around it
  return color;
}

// The sun's real brightness in direction `dir`, for the path tracer. A shadow
// ray and a reflection must find the same sun, or multiple importance sampling
// can't blend them. scene.sunColor × PI is the light a surface facing the sun
// receives, so spreading it over the disk gives the disk's brightness: over
// 10,000 times the painted disk in sky(), which is how bright the sun really
// is next to the sky.
fn sunDisk(dir: vec3f, toSun: vec3f) -> vec3f {
  return select(vec3f(0.0), scene.sunColor * PI * SUN_PDF, dot(dir, toSun) >= cos(SUN_ANGULAR_RADIUS));
}

// The sun is so far away that anything a shadow ray hits counts as blocking it.
fn inShadow(position: vec3f, normal: vec3f, toSun: vec3f) -> bool {
  return blocked(position, normal, toSun, NO_HIT);
}

// ---- Glowing objects -----------------------------------------------------
// A random point on one of the glowing objects, for a shadow ray.
struct LightSample {
  position: vec3f,
  normal: vec3f, // pointing out of the light's surface
  emission: vec3f, // the light given off there
  area: f32, // the light's whole surface area
  probability: f32, // of having picked this light
}

// A point in a box's own coordinates, where it's centered at the origin and
// lined up with the axes.
fn pointInBoxSpace(box: Box, point: vec3f) -> vec3f {
  return (point - box.center) * box.rotation;
}

fn boxSurfaceArea(h: vec3f) -> f32 {
  return 8.0 * (h.x * h.y + h.y * h.z + h.x * h.z);
}

// The area of the box faces a point can see, for the pair of faces across
// each axis. A face is visible only from beyond its own plane, so of each pair
// the point sees at most the one on its side, and none if it's level with the
// box along that axis. `local` is the point in the box's own coordinates.
fn visibleFaceAreas(h: vec3f, local: vec3f) -> vec3f {
  let faceAreas = vec3f(h.y * h.z, h.x * h.z, h.x * h.y) * 4.0;
  return select(vec3f(0.0), faceAreas, abs(local) > h);
}

// Picks a light in proportion to the light it gives off (findLights() in
// scene.ts sets the odds), then a point spread evenly over the part of it that
// `litPoint` can see. For a box, that means the faces turned toward it: aiming at
// the others would waste the shadow ray, since a face can't light what's
// behind it.
fn sampleLight(litPoint: vec3f) -> LightSample {
  let u = random();
  var picked = lights[scene.lightCount - 1u];
  for (var i = 0u; i < scene.lightCount; i++) {
    if (u < lights[i].cdf) {
      picked = lights[i];
      break;
    }
  }

  var s: LightSample;
  s.probability = picked.probability;
  if (picked.kind == LIGHT_SPHERE) {
    let sphere = spheres[picked.index];
    s.normal = randomUnitVector();
    s.position = sphere.center + s.normal * sphere.radius;
    s.area = 4.0 * PI * sphere.radius * sphere.radius;
    s.emission = materials[sphere.material].emission;
  } else {
    // A box: pick one of the faces `litPoint` can see, in proportion to its area,
    // then a point on that face, in the box's own coordinates.
    let box = boxes[picked.index];
    let h = box.halfSize;
    let seenFrom = pointInBoxSpace(box, litPoint);
    let visible = visibleFaceAreas(h, seenFrom);
    s.area = visible.x + visible.y + visible.z;
    if (s.area <= 0.0) {
      return s; // `litPoint` is inside the box, where no face can light it
    }
    let side = sign(seenFrom); // which face of each pair is turned toward `litPoint`
    let along = vec2f(random(), random()) * 2.0 - 1.0; // -1..1 across the face
    let pick = random() * s.area;
    var local: vec3f;
    var n: vec3f;
    if (pick < visible.x) {
      local = vec3f(side.x * h.x, along.x * h.y, along.y * h.z);
      n = vec3f(side.x, 0.0, 0.0);
    } else if (pick < visible.x + visible.y) {
      local = vec3f(along.x * h.x, side.y * h.y, along.y * h.z);
      n = vec3f(0.0, side.y, 0.0);
    } else {
      local = vec3f(along.x * h.x, along.y * h.y, side.z * h.z);
      n = vec3f(0.0, 0.0, side.z);
    }
    s.position = box.center + box.rotation * local;
    s.normal = box.rotation * n;
    s.emission = materials[box.material].emission;
  }
  return s;
}

// The light one glowing object sends off a surface toward the viewer, estimated
// from one random point on it. A patch of glowing surface looks smaller with
// the square of the distance, and smaller again seen edge-on (cosLight). Together
// those turn "chance per m² of the light" into "chance per direction", the
// units scatterToward uses, so `pdf` is comparable with the surface's own.
fn lightFromObjects(surface: Surface, position: vec3f) -> vec3f {
  if (scene.lightCount == 0u) {
    return vec3f(0.0);
  }
  // Measured from where the ray really starts. Measured from the surface, the
  // offset shortens the true trip to a light it faces, so closer than about a
  // meter, a ray reached the light before it stopped and was "blocked" by it.
  let start = position + surface.normal * EPSILON;
  let s = sampleLight(start);
  if (s.area <= 0.0) {
    return vec3f(0.0); // inside a glowing box
  }
  let toLight = s.position - start;
  let distanceSquared = dot(toLight, toLight);
  let distance = sqrt(distanceSquared);
  let dir = toLight / distance;
  let cosLight = -dot(s.normal, dir);
  let scatter = scatterToward(surface, dir);
  if (cosLight <= 0.0 || scatter.pdf <= 0.0) {
    return vec3f(0.0); // the patch faces away from the point, or the point from the patch
  }
  // Stop just short of the light, so its own surface doesn't count as a blocker.
  if (intersectScene(Ray(start, dir)).t < distance - EPSILON) {
    return vec3f(0.0);
  }
  // Dividing by the chance of this direction makes the estimate right on average.
  let pdf = s.probability * distanceSquared / (s.area * cosLight);
  return s.emission * scatter.value * misWeight(pdf, scatter.pdf) / pdf;
}

// Whitted's version: each glowing object as a single point of light at its
// center, so shadows are hard and there's no bounce light. On average a
// convex object shows a quarter of its surface area from any direction
// (Cauchy's formula), which sets how bright that point is.
fn lightFromObjectsWhitted(position: vec3f, normal: vec3f) -> vec3f {
  var total = vec3f(0.0);
  for (var i = 0u; i < scene.lightCount; i++) {
    let light = lights[i];
    var center: vec3f;
    var reach: f32; // how far the object's surface sticks out from its center
    var area: f32;
    var emission: vec3f;
    if (light.kind == LIGHT_SPHERE) {
      let sphere = spheres[light.index];
      center = sphere.center;
      reach = sphere.radius;
      area = 4.0 * PI * sphere.radius * sphere.radius;
      emission = materials[sphere.material].emission;
    } else {
      let box = boxes[light.index];
      let h = box.halfSize;
      center = box.center;
      reach = length(h);
      area = 8.0 * (h.x * h.y + h.y * h.z + h.x * h.z);
      emission = materials[box.material].emission;
    }
    let toLight = center - position;
    let distanceSquared = dot(toLight, toLight);
    let distance = sqrt(distanceSquared);
    let dir = toLight / distance;
    let cosSurface = dot(normal, dir);
    if (cosSurface > 0.0 && !blocked(position, normal, dir, distance - reach)) {
      total += emission * cosSurface * (area / 4.0) / (PI * distanceSquared);
    }
  }
  return total;
}

// ---- Surfaces ------------------------------------------------------------
// Flattens a point onto the plane its surface mostly lies in, so that patterns
// run across a wall instead of smearing down it. There are three choices, one
// for each axis the surface can face, so a pattern on a sphere has seams.
fn flatten(position: vec3f, normal: vec3f) -> vec2f {
  let facing = abs(normal);
  if (facing.y >= facing.x && facing.y >= facing.z) {
    return position.xz;
  }
  return select(position.xy, position.zy, facing.x >= facing.z);
}

// How much tiles differ. No two real tiles match: each is a slightly different
// shade, and each is set at a slightly different angle, which breaks a
// reflection up at every tile. A perfectly flat floor looks computer-made.
const TILE_SHADE = 0.08; // the brightest and darkest tile differ by this share
const TILE_TILT = 0.01; // sideways lean of a tile's normal, at most ±0.3° each way
const GROUT_ROUGHNESS = 0.9; // cement, between glazed tiles

struct TileSpot {
  inGrout: bool,
  id: u32, // the same all over one tile, and unrelated to its neighbors'
}

fn tileAt(material: Material, position: vec3f, normal: vec3f) -> TileSpot {
  let grid = flatten(position, normal) / material.cellSize;
  // Distance from the middle of the tile, as a share of its width: 0.5 is the edge.
  let fromMiddle = abs(fract(grid) - 0.5);
  let cell = vec2i(floor(grid));
  return TileSpot(
    max(fromMiddle.x, fromMiddle.y) > 0.5 - 0.5 * material.groutWidth / material.cellSize,
    pcgHash(bitcast<u32>(cell.x) + pcgHash(bitcast<u32>(cell.y))),
  );
}

// The baseColor at a point: a non-metal's albedo, or a metal's tint.
fn surfaceColor(material: Material, position: vec3f, normal: vec3f) -> vec3f {
  if (material.groutWidth > 0.0) {
    let spot = tileAt(material, position, normal);
    if (spot.inGrout) {
      return material.colorB;
    }
    return material.colorA * (1.0 + TILE_SHADE * (unitFromHash(spot.id) - 0.5));
  }
  if (material.cellSize > 0.0) {
    // Squares cellSize wide: the parity of the integer square coordinates
    // picks the color.
    let cell = vec2i(floor(flatten(position, normal) / material.cellSize));
    return select(material.colorA, material.colorB, ((cell.x + cell.y) & 1) == 1);
  }
  return material.colorA;
}

// The Fresnel effect: every surface reflects more at a grazing angle, and at
// the very edge it's a perfect mirror. `f0` is how much it reflects head-on,
// and `cosine` is 1 head-on and 0 at the edge. This is Schlick's approximation,
// which glTF uses: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#fresnel
// The power is multiplied out because WGSL defines pow() through log2(x), which
// has no finite value at x = 0: https://www.w3.org/TR/WGSL/#floating-point-accuracy
fn fresnel(f0: vec3f, cosine: f32) -> vec3f {
  let c = 1.0 - cosine;
  return f0 + (1.0 - f0) * (c * c * c * c * c);
}

// Schlick's approximation needs the angle on the side where light moves
// fastest. Inside glass (eta > 1) that's the outgoing ray's angle, from Snell's
// law. When no such angle exists, light can't get out ("total internal
// reflection"); this returns 0, which makes fresnel() reflect everything.
fn outerCosine(cosine: f32, eta: f32) -> f32 {
  if (eta <= 1.0) {
    return cosine;
  }
  return sqrt(max(0.0, 1.0 - eta * eta * (1.0 - cosine * cosine)));
}

// Below this roughness, a surface counts as a perfect mirror. Its reflection is
// one exact direction, so shadow rays could never find it. It also keeps the
// sums below clear of the limits of 32-bit numbers.
const POLISHED_ROUGHNESS = 0.01;

// A hit point, with the material's blends settled. A surface that's partly
// metal or partly see-through is treated as all one thing at each hit, picked
// at random with those odds, which is right on average.
struct Surface {
  normal: vec3f, // facing the incoming ray
  tangents: mat2x3f, // at right angles to normal, for the GGX sums
  toView: vec3f, // back along the incoming ray
  cosView: f32, // 1 head-on, 0 at a grazing angle
  albedo: vec3f, // the matte layer's color; black if it has none
  f0: vec3f, // how much the surface reflects head-on
  alpha: f32, // GGX's width: glTF's roughness²
  polished: bool, // a perfect mirror: see POLISHED_ROUGHNESS
  specularChance: f32, // how often a bounce uses the reflection; the rest go to the matte layer
  transmits: bool, // glass: light passes through instead of reaching a matte layer
  usesShadowRays: bool, // false where a shadow ray couldn't find anything
  entering: bool, // false when the ray is inside the object
  tint: vec3f, // glass: the color of light passing through
  eta: f32, // glass: index of refraction on the ray's side ÷ on the far side; else 1
}

fn surfaceAt(material: Material, hit: Hit, ray: Ray) -> Surface {
  var s: Surface;
  s.entering = dot(ray.dir, hit.normal) < 0.0;
  s.normal = select(-hit.normal, hit.normal, s.entering);
  var roughness = material.roughness;
  if (material.groutWidth > 0.0) {
    let spot = tileAt(material, hit.position, hit.normal);
    if (spot.inGrout) {
      roughness = GROUT_ROUGHNESS;
    } else {
      // Hashes of the tile's id, not random(): a tile keeps its lean in every
      // sample, while the pixel's random numbers carry on unchanged.
      let lean = vec2f(unitFromHash(pcgHash(spot.id)), unitFromHash(pcgHash(spot.id + 1u))) - 0.5;
      let side = perpendiculars(s.normal);
      s.normal = normalize(s.normal + (side[0] * lean.x + side[1] * lean.y) * TILE_TILT);
    }
  }
  s.tangents = perpendiculars(s.normal);
  s.toView = -ray.dir;
  s.cosView = max(dot(s.normal, s.toView), 1e-5);
  s.alpha = roughness * roughness;
  s.polished = roughness < POLISHED_ROUGHNESS;
  s.eta = 1.0;

  let color = surfaceColor(material, hit.position, hit.normal);
  if (material.metallic > 0.0 && random() < material.metallic) {
    // A metal absorbs any light that enters it, so it's only a tinted
    // reflection, with no matte layer.
    s.f0 = color;
    s.specularChance = 1.0;
    s.usesShadowRays = !s.polished;
    return s;
  }

  // A non-metal reflects the same amount of every color, a share set by its
  // index of refraction: 0.04 for the usual 1.5.
  let r = (1.0 - material.ior) / (1.0 + material.ior);
  s.f0 = vec3f(r * r);
  if (material.transmission > 0.0 && random() < material.transmission) {
    s.transmits = true;
    s.tint = color;
    s.eta = select(material.ior, 1.0 / material.ior, s.entering);
    // From inside, a shadow ray would hit the object's own surface. Light that
    // passes through bends, so a straight shadow ray can't follow it either;
    // only rough glass's reflection, from outside, can use one.
    s.usesShadowRays = s.entering && !s.polished;
    return s;
  }
  // Under the reflection is a matte layer. Spend bounces on whichever looks
  // brighter from here, never ignoring either: on a black floor the reflection
  // is nearly all there is, even when it's only 4%.
  s.albedo = color;
  s.usesShadowRays = true;
  let reflected = fresnel(s.f0, s.cosView).x;
  let matte = (1.0 - reflected) * dot(color, vec3f(0.2126, 0.7152, 0.0722));
  s.specularChance = clamp(reflected / (reflected + matte + 1e-5), 0.05, 0.95);
  return s;
}

// The GGX distribution: the density of tiny mirrors facing `halfway`. glTF
// writes it as α² / (π((N·H)²(α² - 1) + 1)²). This equal form uses the tiny
// sideways parts of `halfway` directly, because working them out from N·H ≈ 1
// would lose them to rounding on a nearly smooth surface.
// https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#specular-brdf
fn ggxDistribution(s: Surface, halfway: vec3f) -> f32 {
  let alpha2 = s.alpha * s.alpha;
  let x = dot(halfway, s.tangents[0]);
  let y = dot(halfway, s.tangents[1]);
  let z = dot(halfway, s.normal);
  let k = (x * x + y * y) / alpha2 + z * z;
  return 1.0 / (PI * alpha2 * k * k);
}

// The bottom half of glTF's visibility term, for one direction. It accounts for
// tiny mirrors hidden behind their neighbors.
fn smithTerm(cosine: f32, alpha: f32) -> f32 {
  let alpha2 = alpha * alpha;
  return cosine + sqrt(alpha2 + (1.0 - alpha2) * cosine * cosine);
}

// A random tiny mirror, out of those the viewer can see. Picking only visible
// ones means few bounces are wasted. This is the "spherical caps" method of
// Dupuy and Benyoub (2023), listings 1 and 3: https://arxiv.org/abs/2306.05044
fn sampleVisibleNormal(s: Surface) -> vec3f {
  // Everything in the surface's own coordinates, where it faces +z.
  let view = vec3f(dot(s.toView, s.tangents[0]), dot(s.toView, s.tangents[1]), s.cosView);
  // Stretch space so that the tiny mirrors' shape becomes a plain half sphere.
  let stretched = normalize(vec3f(view.xy * s.alpha, view.z));
  let angle = 2.0 * PI * random();
  let z = (1.0 - random()) * (1.0 + stretched.z) - stretched.z;
  let r = sqrt(saturate(1.0 - z * z));
  let halfway = vec3f(r * cos(angle), r * sin(angle), z) + stretched;
  // Stretch back, and turn the result to point around the real normal.
  let local = normalize(vec3f(halfway.xy * s.alpha, halfway.z));
  return s.tangents[0] * local.x + s.tangents[1] * local.y + s.normal * local.z;
}

// What a surface does with light arriving from `dir`.
struct Scatter {
  value: vec3f, // how much of it heads toward the viewer, cosine included
  pdf: f32, // the chance density of a bounce going in this direction
}

fn scatterToward(s: Surface, dir: vec3f) -> Scatter {
  let cosDir = dot(s.normal, dir);
  if (cosDir <= 0.0) {
    return Scatter(vec3f(0.0), 0.0);
  }
  let matteChance = select(1.0 - s.specularChance, 0.0, s.transmits);
  if (s.polished) {
    // The mirror reflects one exact direction, which this isn't. That leaves
    // the matte layer, under whatever the reflection took.
    let matte = (1.0 - fresnel(s.f0, s.cosView)) * s.albedo;
    return Scatter(matte * cosDir / PI, matteChance * cosDir / PI);
  }

  // Only tiny mirrors facing halfway between the viewer and `dir` send light
  // from one to the other. glTF's model is D · V · F, for the share of mirrors
  // lined up, the share not hidden, and how strongly each one reflects.
  let halfway = normalize(s.toView + dir);
  let f = fresnel(s.f0, outerCosine(saturate(dot(s.toView, halfway)), s.eta));
  let d = ggxDistribution(s, halfway);
  let viewTerm = smithTerm(s.cosView, s.alpha);
  let specular = d * f / (viewTerm * smithTerm(cosDir, s.alpha));
  let matte = (1.0 - f) * s.albedo / PI;
  // Glass picks its reflection by Fresnel, in sampleGlass.
  let reflectChance = select(s.specularChance, f.x, s.transmits);
  // sampleVisibleNormal's density, as a density of reflected directions.
  let reflectPdf = d / (2.0 * viewTerm);
  return Scatter((specular + matte) * cosDir, reflectChance * reflectPdf + matteChance * cosDir / PI);
}

// Multiple importance sampling. Shadow rays and bounce rays can both find a
// light, and each is good where the other is bad. Both results count, each
// with this share of the credit, so nothing is counted twice. `pdf` is how
// likely the method that found it was to go this way, and `other` is the same
// for the method that didn't. This is the power heuristic with β = 2:
// https://pbr-book.org/4ed/Monte_Carlo_Integration/Improving_Efficiency#MultipleImportanceSampling
fn misWeight(pdf: f32, other: f32) -> f32 {
  let ratio = other / pdf;
  return 1.0 / (1.0 + ratio * ratio);
}

// Where a path goes next.
struct Bounce {
  ray: Ray,
  weight: vec3f, // multiplies throughput; black ends the path
  pdf: f32, // the direction's chance density, or 0 if shadow rays can't reach
            // the same lights from here, so that whatever it finds counts in full
}

const NO_BOUNCE = Bounce(Ray(vec3f(0.0), vec3f(0.0)), vec3f(0.0), 0.0);

fn sampleBounce(s: Surface, position: vec3f) -> Bounce {
  if (s.transmits) {
    return sampleGlass(s, position);
  }
  let start = position + s.normal * EPSILON;
  var dir: vec3f;
  if (random() < s.specularChance) {
    if (s.polished) {
      let f = fresnel(s.f0, s.cosView);
      return Bounce(Ray(start, reflect(-s.toView, s.normal)), f / s.specularChance, 0.0);
    }
    dir = reflect(-s.toView, sampleVisibleNormal(s));
  } else {
    // A matte surface scatters light more toward its normal than sideways
    // (Lambert's cosine law again), so directions near the normal are chosen
    // more often: a random point on a unit sphere resting on the surface gives
    // exactly that spread ("cosine-weighted").
    let spread = s.normal + randomUnitVector();
    dir = select(normalize(spread), s.normal, dot(spread, spread) < 1e-8);
  }
  // Either way, the reflection and the matte layer could both have picked this
  // direction, so both count in the weight.
  let scatter = scatterToward(s, dir);
  if (scatter.pdf <= 0.0) {
    return NO_BOUNCE;
  }
  return Bounce(Ray(start, dir), scatter.value / scatter.pdf, scatter.pdf);
}

// Glass reflects a share F of the light and lets the rest through, so a ray
// does one or the other with exactly those odds, leaving no weight but the tint.
// On rough glass, each tiny mirror bends the ray its own way, which is what
// makes it frosted (Walter et al., 2007: https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf).
fn sampleGlass(s: Surface, position: vec3f) -> Bounce {
  var facing = s.normal;
  if (!s.polished) {
    facing = sampleVisibleNormal(s);
  }
  let cosFacing = saturate(dot(s.toView, facing));
  let f = fresnel(s.f0, outerCosine(cosFacing, s.eta)).x;
  if (random() < f) {
    let dir = reflect(-s.toView, facing);
    let ray = Ray(position + s.normal * EPSILON, dir);
    if (s.polished) {
      return Bounce(ray, vec3f(1.0), 0.0);
    }
    let scatter = scatterToward(s, dir);
    if (scatter.pdf <= 0.0) {
      return NO_BOUNCE;
    }
    return Bounce(ray, scatter.value / scatter.pdf, select(0.0, scatter.pdf, s.usesShadowRays));
  }

  // refract() takes the ratio of indices, and returns zero if light can't get
  // out, but then f is 1 and this line isn't reached.
  // https://www.w3.org/TR/WGSL/#refract-builtin
  let dir = refract(-s.toView, facing, s.eta);
  let cosDir = -dot(dir, s.normal);
  if (cosDir <= 0.0) {
    return NO_BOUNCE; // bent back to the side it came from, by a very slanted tiny mirror
  }
  // Tinting on the way in only: light going all the way through shows the
  // color once, as the glTF tint does for a thin wall. The surface hides some
  // tiny mirrors from `dir`, as in scatterToward: 2 · cos / smithTerm.
  var weight = select(vec3f(1.0), s.tint, s.entering);
  if (!s.polished) {
    weight *= 2.0 * cosDir / smithTerm(cosDir, s.alpha);
  }
  return Bounce(Ray(position - s.normal * EPSILON, dir), weight, 0.0);
}

// Fade distant surfaces into the sky color, like haze. In C0 it also hid the
// checkerboard flickering near the horizon; anti-aliasing now fixes that.
// Only scenes with a ground plane are out in the open. In a room, this would
// tint the walls with a sky that can't be seen from there.
fn haze(surface: vec3f, distance: f32, dir: vec3f, toSun: vec3f) -> vec3f {
  if (scene.groundMaterial == NO_GROUND) {
    return surface;
  }
  return mix(surface, sky(dir, toSun, true), 1.0 - exp(-distance * 0.012));
}

// ---- Renderer 1: Whitted (C0) --------------------------------------------
const MAX_MIRROR_BOUNCES = 4;

fn traceWhitted(primary: Ray) -> vec3f {
  let toSun = sunDirection();
  var ray = primary;
  // How much of the light found further along reaches the camera. Starts at
  // 1 and is reduced by each mirror bounce (no mirror is perfect).
  var throughput = vec3f(1.0);
  var color = vec3f(0.0);

  for (var bounce = 0; bounce < MAX_MIRROR_BOUNCES; bounce++) {
    let hit = intersectScene(ray);
    if (hit.t >= NO_HIT) {
      return color + throughput * sky(ray.dir, toSun, true);
    }

    let material = materials[hit.material];
    color += throughput * material.emission; // glowing surfaces show their own light
    if (material.metallic >= 0.5) {
      // This renderer stays a simple comparison: metals are perfect mirrors
      // with a fixed tint, and everything else is matte. Reflect the direction
      // about the normal and continue.
      throughput *= surfaceColor(material, hit.position, hit.normal);
      ray = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
      continue;
    }

    // Matte surface. Lambert's cosine law: light arriving at a grazing angle
    // spreads over more area, so the surface looks dimmer.
    let cosine = max(dot(hit.normal, toSun), 0.0);
    var direct = vec3f(0.0);
    if (cosine > 0.0 && !inShadow(hit.position, hit.normal, toSun)) {
      direct = scene.sunColor * cosine;
    }
    direct += lightFromObjectsWhitted(hit.position, hit.normal);
    // Whitted ray tracing has no bounce light, so light arriving from the sky
    // and from other surfaces is faked with a constant "ambient" term.
    let ambient = vec3f(0.16, 0.2, 0.28) * (0.5 + 0.5 * hit.normal.y) * scene.skyStrength;
    let surface = surfaceColor(material, hit.position, hit.normal) * (direct + ambient);
    return color + throughput * haze(surface, hit.t, ray.dir, toSun);
  }
  return color; // ran out of bounces between mirrors
}

// ---- Renderer 2: path tracer (C1) ----------------------------------------
// Follows one random path of light backwards from the camera. At each surface
// it adds the light arriving there directly from the sun and the glowing
// objects (via shadow rays) and then bounces on in a random direction, until
// the path escapes to the sky (which adds the sky's light) or ends.
//
// How many surfaces a path can visit comes from the Bounces slider
// (frame.maxBounces, 8 by default). With 1, a path stops at the first
// surface the camera sees: it only gets light straight from the sun, the
// sky and glowing objects ("direct light"). Each more adds light that has
// bounced once more first ("indirect light"): color bleeding, light around
// corners, mirrors showing mirrors. Russian roulette below ends most paths
// long before the limit, so raising it costs little except where light
// keeps bouncing between mirrors or through glass.

// Once a path has scattered off something rough, this is the most light one
// step of it can add. A rare path can reach something very bright, such as the
// sun through glass. On average that's a little light, but a single sample of
// it stays visible as a bright speck (a "firefly") for thousands of samples.
// Capping it removes a little real light in exchange for a clean image, like
// Clamp Indirect in Blender's Cycles renderer:
// https://docs.blender.org/manual/en/latest/render/cycles/render_settings/light_paths.html#clamping
const MAX_SCATTERED_LIGHT = 10.0;

fn limitScattered(value: vec3f, scattered: bool) -> vec3f {
  let brightest = max(value.r, max(value.g, value.b));
  if (!scattered || brightest <= MAX_SCATTERED_LIGHT) {
    return value;
  }
  return value * (MAX_SCATTERED_LIGHT / brightest);
}

// The share of the credit for a light found by a bounce ray. See misWeight.
fn bounceShare(bouncePdf: f32, shadowRayPdf: f32) -> f32 {
  if (bouncePdf <= 0.0) {
    return 1.0;
  }
  return misWeight(bouncePdf, shadowRayPdf);
}

fn tracePath(primary: Ray) -> vec3f {
  let toSun = sunDirection();
  var ray = primary;
  var throughput = vec3f(1.0);
  var light = vec3f(0.0); // gathered so far
  var firstHitDistance = NO_HIT;
  // The last bounce's chance density, or 0 if shadow rays can't have found
  // what this ray finds: camera rays, perfect mirrors and glass.
  var bouncePdf = 0.0;
  var scattered = false; // whether the path has left anything rough or matte
  // For finding firstSurface: whether it's still to be found, how far the
  // path has come, and the perfect mirrors on the way.
  var seeking = true;
  var throughMirror = false;
  var travelled = 0.0;
  var mirrorTint = vec3f(1.0);
  var mirrors = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);

  for (var bounce = 0u; bounce < frame.maxBounces; bounce++) {
    let hit = intersectScene(ray);
    if (bounce == 0u) {
      firstHitDistance = hit.t;
    }
    if (hit.t >= NO_HIT) {
      // Only the camera ray counts: a path that met a light first and
      // escaped later is still a direct view of that light.
      if (bounce == 0u) {
        directGlow = true;
      }
      // The path escaped: the sky is a light source, so whatever it shows in
      // this direction is light arriving along the path.
      let disk = sunDisk(ray.dir, toSun) * bounceShare(bouncePdf, SUN_PDF);
      light += limitScattered(throughput * (sky(ray.dir, toSun, false) + disk), scattered);
      break;
    }

    let material = materials[hit.material];
    if (seeking) {
      // What the camera sees, for the denoiser (see firstSurface). This only
      // watches the path: surfaceColor() uses no random numbers, so the path
      // comes out exactly as it would without it.
      travelled += hit.t;
      let facing = select(-hit.normal, hit.normal, dot(ray.dir, hit.normal) < 0.0);
      let color = surfaceColor(material, hit.position, hit.normal);
      if (isPerfectMirror(material)) {
        // The path reflects exactly here (sampleBounce), so carry on to what
        // the mirror shows, tinted by it.
        mirrorTint *= color;
        mirrors = mirrors * mirrorMatrix(facing);
        throughMirror = true;
      } else {
        seeking = false;
        firstDepth = travelled;
        directGlow = bounce == 0u && any(material.emission != vec3f(0.0));
        if (all(material.emission == vec3f(0.0))) {
          firstColor = mirrorTint * color;
          firstSurface = vec4f(mirrors * facing, select(travelled, -travelled, throughMirror));
        }
      }
    }
    // If it glows, a shadow ray might have found this point too. That chance,
    // as in lightFromObjects, comes from the distance and the angle.
    let cosLight = max(abs(dot(ray.dir, hit.normal)), 1e-5);
    let share = bounceShare(bouncePdf, hit.lightDensity * hit.t * hit.t / cosLight);
    light += limitScattered(throughput * material.emission * share, scattered);

    let surface = surfaceAt(material, hit, ray);

    // First, light arriving directly, through shadow rays: one toward a
    // random point on the sun ("next-event estimation") and one toward a
    // random point on a glowing object. Only sending bounce rays would find
    // the tiny sun or a small lamp by chance, almost never.
    if (surface.usesShadowRays) {
      var direct = lightFromObjects(surface, hit.position);
      let sunRay = sampleSunDirection(toSun);
      let sun = scatterToward(surface, sunRay);
      if (sun.pdf > 0.0 && !inShadow(hit.position, surface.normal, sunRay)) {
        direct += sun.value * scene.sunColor * PI * misWeight(SUN_PDF, sun.pdf);
      }
      light += limitScattered(throughput * direct, scattered);
    }

    // Then continue the path.
    let next = sampleBounce(surface, hit.position);
    if (all(next.weight == vec3f(0.0))) {
      break;
    }
    throughput *= next.weight;
    ray = next.ray;
    bouncePdf = next.pdf;
    scattered = scattered || next.pdf > 0.0 || !surface.polished;

    // Russian roulette: after a few bounces, end paths at random, more often
    // the less light they can still carry, and brighten the survivors to make
    // up for it. On average the result is unchanged, but little time goes on
    // paths that hardly matter. Mirrors and glass lose almost no light, so
    // paths through them just run out of bounces.
    if (bounce >= 2u && bouncePdf > 0.0) {
      let keep = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.05, 0.95);
      if (random() >= keep) {
        break;
      }
      throughput /= keep;
    }
  }

  if (firstHitDistance < NO_HIT) {
    light = haze(light, firstHitDistance, primary.dir, toSun);
  }
  return light;
}

// ---- Debug views ---------------------------------------------------------
// The same for both renderers (except VIEW_RAYS, handled in fs): they follow
// mirrors to the first matte surface and show one property of it.

// VIEW_SUNLIGHT: the two ways a point can miss the sun.
fn sunlightView(hit: Hit, toSun: vec3f) -> vec3f {
  if (dot(hit.normal, toSun) <= 0.0) {
    return vec3f(0.1, 0.15, 0.45); // blue: faces away from the sun, so no shadow ray is needed
  }
  // The path tracer's sun has a size, so its shadow edges come out soft here too.
  let sunRay = select(toSun, sampleSunDirection(toSun), frame.renderer == RENDERER_PATH);
  if (inShadow(hit.position, hit.normal, sunRay)) {
    return vec3f(1.0, 0.45, 0.1); // orange: the shadow ray hit something (a cast shadow)
  }
  return vec3f(1.0); // white: the sun reaches it
}

fn debugView(primary: Ray) -> vec3f {
  let toSun = sunDirection();
  var ray = primary;
  var tint = vec3f(1.0);
  var travelled = 0.0;
  for (var bounce = 0; bounce < MAX_MIRROR_BOUNCES; bounce++) {
    let hit = intersectScene(ray);
    if (hit.t >= NO_HIT) {
      if (frame.view == VIEW_MOTION) {
        // The sky is infinitely far away, so only turning moves it.
        return motionColor(primary.origin + primary.dir * 1e6);
      }
      return select(vec3f(0.0), tint * sky(ray.dir, toSun, true), frame.view == VIEW_COLOR);
    }
    travelled += hit.t;
    let material = materials[hit.material];
    if (material.metallic >= 0.5) {
      tint *= surfaceColor(material, hit.position, hit.normal);
      ray = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
      continue;
    }
    switch frame.view {
      case VIEW_COLOR: {
        return tint * surfaceColor(material, hit.position, hit.normal); // the albedo
      }
      case VIEW_NORMALS: {
        return hit.normal * 0.5 + 0.5; // each axis from -1..1 to 0..1
      }
      case VIEW_DISTANCE: {
        return vec3f(exp(-travelled * 0.1)); // near is bright, far fades to black
      }
      case VIEW_MOTION: {
        // In a mirror, what moves is the mirror image: the point as far along
        // the camera ray as the reflected path is long (see firstSurface).
        return motionColor(primary.origin + primary.dir * travelled);
      }
      default: {
        return sunlightView(hit, toSun);
      }
    }
  }
  return vec3f(0.0);
}

// ---- Motion vectors ------------------------------------------------------
// Where a point lands on screen for a camera, in pixels from the top-left
// corner, y down: the inverse of how fs() aims a ray through a pixel.
// camera/project.ts has a copy for tests.
fn projectToPixel(point: vec3f, position: vec3f, right: vec3f, up: vec3f, forward: vec3f) -> vec2f {
  let d = point - position;
  let depth = max(dot(d, forward), 1e-6); // behind the camera only happens for points that just came into view
  let ndc = vec2f(
    dot(d, right) / (depth * frame.tanHalfFovY * frame.aspect),
    dot(d, up) / (depth * frame.tanHalfFovY),
  );
  return vec2f((ndc.x + 1.0) * 0.5, (1.0 - ndc.y) * 0.5) * frame.resolution;
}

// How far, in pixels, a point moved on screen since the last frame: where it
// is now minus where it was. Reusing last frame's samples means looking up
// each pixel's point at "where it was".
fn motionVector(point: vec3f) -> vec2f {
  let now = projectToPixel(point, frame.cameraPos, frame.cameraRight, frame.cameraUp, frame.cameraForward);
  let then = projectToPixel(
    point,
    frame.previousCameraPos,
    frame.previousCameraRight,
    frame.previousCameraUp,
    frame.previousCameraForward,
  );
  return now - then;
}

// ---- Reusing last frame's samples (reprojection) ---------------------------
// While the camera moves, each pixel looks for its point in last frame's
// records: where the point was on screen (projectToPixel with last frame's
// camera), blending the 4 records around that spot by how near each one's
// center is ("bilinear" sampling). Records that show a different surface
// are left out: the point was hidden behind something last frame, or is
// on the far side of an edge. If none is left, the pixel starts over.

// Stands in for "infinitely far" (the sky) when reprojecting: far enough that
// moving the camera makes no difference, near enough for 32-bit floats.
const FAR_AWAY = 1e6;
// A record counts as the same surface if it faces within about 25° of this
// sample's ...
const MIN_HISTORY_FACING = 0.9;
// ... and lies within this many pixel widths of its plane. Neighbors on the
// same flat surface are on it exactly; the gap behind a column is far more.
const HISTORY_PLANE_TOLERANCE = 4.0;
// Records adding up to less than this weight are too few to trust.
const MIN_HISTORY_WEIGHT = 0.05;

// The unit ray last frame's camera aimed through a point on its screen.
fn previousRay(pixel: vec2f) -> vec3f {
  let ndc = vec2f(pixel.x / frame.resolution.x * 2.0 - 1.0, 1.0 - pixel.y / frame.resolution.y * 2.0);
  return normalize(
    frame.previousCameraForward
      + frame.previousCameraRight * (ndc.x * frame.tanHalfFovY * frame.aspect)
      + frame.previousCameraUp * (ndc.y * frame.tanHalfFovY),
  );
}

// Whether a record, kept for the pixel centered at `center` last frame, shows
// the same surface as this sample, which hit `surface` at `point`. Sky and
// lights (NO_HIT) only match each other, and mirror images (negative
// distance) only other mirror images.
fn sameSurface(stored: vec4f, center: vec2f, surface: vec4f, point: vec3f) -> bool {
  let storedEmpty = stored.w >= NO_HIT;
  let sampleEmpty = surface.w >= NO_HIT;
  if (storedEmpty || sampleEmpty) {
    return storedEmpty && sampleEmpty;
  }
  if ((stored.w < 0.0) != (surface.w < 0.0) || dot(stored.xyz, surface.xyz) < MIN_HISTORY_FACING) {
    return false;
  }
  let storedPoint = frame.previousCameraPos + previousRay(center) * abs(stored.w);
  let pixelWidth = abs(surface.w) * 2.0 * frame.tanHalfFovY / frame.resolution.y;
  return abs(dot(surface.xyz, storedPoint - point)) < HISTORY_PLANE_TOLERANCE * pixelWidth;
}

struct Reprojected {
  record: PixelRecord, // the blend of the matching records
  found: bool, // false: nothing matched, so start over
}

fn reproject(point: vec3f, surface: vec4f) -> Reprojected {
  var result: Reprojected; // all zero: nothing found
  if (frame.maxHistory <= 0.0) {
    return result; // History slider at 0: every moving frame starts over, as before C2
  }
  // Behind last frame's camera, it can't have been on screen.
  if (dot(point - frame.previousCameraPos, frame.previousCameraForward) <= 0.0) {
    return result;
  }
  let was = projectToPixel(
    point,
    frame.previousCameraPos,
    frame.previousCameraRight,
    frame.previousCameraUp,
    frame.previousCameraForward,
  );
  // Pixel centers sit at whole numbers + 0.5. The 4 around `was` start at
  // `corner`, and `f` is how far `was` is across from it, 0 to 1 each way.
  let corner = floor(was - 0.5);
  let f = was - 0.5 - corner;
  var weights = 0.0;
  for (var i = 0u; i < 4u; i++) {
    let step = vec2f(f32(i & 1u), f32(i >> 1u));
    let tap = corner + step;
    let w = mix(1.0 - f.x, f.x, step.x) * mix(1.0 - f.y, f.y, step.y);
    if (w <= 0.0 || any(tap < vec2f(0.0)) || any(tap >= frame.resolution)) {
      continue;
    }
    let earlier = history[u32(tap.y) * u32(frame.resolution.x) + u32(tap.x)];
    if (!sameSurface(earlier.surface, tap + 0.5, surface, point)) {
      continue;
    }
    // The records hold totals over their samples, counts included, so a
    // weighted blend of them is a weighted pool of those samples.
    result.record.light += w * earlier.light;
    result.record.albedo += w * earlier.albedo;
    result.record.noiseFree += w * earlier.noiseFree;
    weights += w;
  }
  if (weights < MIN_HISTORY_WEIGHT) {
    return Reprojected(result.record, false);
  }
  result.record.light /= weights;
  result.record.albedo /= weights;
  result.record.noiseFree /= weights;
  // While moving, history counts as at most frame.maxHistory samples (the
  // History slider), so older samples fade: their lighting from other
  // viewpoints, and the blur each frame's lookup between pixels adds.
  // Standing still there's no cap, so a still picture converges fully.
  // Short is noisy but crisp; long is smooth but smears and lags.
  let count = result.record.albedo.a;
  if (count > frame.maxHistory) {
    let keep = frame.maxHistory / count;
    result.record.light *= keep;
    result.record.albedo *= keep;
    result.record.noiseFree *= keep;
  }
  result.found = true;
  return result;
}

// Reading the history between pixels blurs it a little, every frame, and
// over many frames a texture's fine lines (tile grout) wash out. Lighting is
// smooth and can take the blur; color can't. So, as SVGF does, the history's
// light is divided by its old color and multiplied by a recent one: an
// average over only the last few samples, which keeps textures sharp. Its
// color is the same idea as demodulation in denoise.wgsl.
const RECENT_COLOR_SAMPLES = 4.0;
// As in denoise.wgsl: colors darker than this count as this dark, so tiny
// colors can't blow light up into huge numbers.
const COLOR_FLOOR = 0.01;
// Light that isn't in proportion to color (a glint, haze) would be scaled
// wrongly where the color changes a lot, as on a black-and-white checker; so
// a step is never more than this, either way.
const MAX_RECOLOR = 4.0;

fn recolored(history: PixelRecord, color: vec3f) -> PixelRecord {
  let rest = history.albedo.a - history.noiseFree.a; // the samples in the light and color totals
  if (rest < 0.5) {
    return history;
  }
  let was = max(history.albedo.rgb / rest, vec3f(COLOR_FLOOR));
  let now = max(mix(was, color, 1.0 / min(rest + 1.0, RECENT_COLOR_SAMPLES)), vec3f(COLOR_FLOOR));
  let scale = clamp(now / was, vec3f(1.0 / MAX_RECOLOR), vec3f(MAX_RECOLOR));
  // The brightness² total scales with the square of the brightness.
  let brightness = clamp(luminance(now) / luminance(was), 1.0 / MAX_RECOLOR, MAX_RECOLOR);
  var result = history;
  result.light = vec4f(history.light.rgb * scale, history.light.a * brightness * brightness);
  result.albedo = vec4f(now * rest, history.albedo.a);
  return result;
}

// A jittered sample's surface, as the record keeps it: the distance along
// the ray through the pixel's *center* to the sample's surface (or the plane
// it lies in). The denoiser and the next frame's reprojection rebuild points
// from center rays; with the jittered ray's own distance, a floor seen at a
// grazing angle would come out up to a pixel's depth off its plane.
fn surfaceForCenter(surface: vec4f, point: vec3f, pixelIndex: vec2u) -> vec4f {
  if (surface.w >= NO_HIT) {
    return surface;
  }
  let center = vec2f(pixelIndex) + 0.5;
  let ndc = vec2f(center.x / frame.resolution.x * 2.0 - 1.0, 1.0 - center.y / frame.resolution.y * 2.0);
  let dir = normalize(
    frame.cameraForward
      + frame.cameraRight * (ndc.x * frame.tanHalfFovY * frame.aspect)
      + frame.cameraUp * (ndc.y * frame.tanHalfFovY),
  );
  let across = dot(surface.xyz, dir);
  let distance = dot(surface.xyz, point - frame.cameraPos) / across;
  // Seen exactly edge-on, the plane gives no answer; keep the sample's own.
  // A mirror image keeps its negative sign.
  let centered = select(distance, -distance, surface.w < 0.0);
  return vec4f(surface.xyz, select(surface.w, centered, abs(across) > 1e-3 && distance > 0.0));
}

// VIEW_MOTION: the direction a point moved as a hue (right red, down
// yellow-green, left cyan, up violet), and how far as brightness: black for
// still, half bright at about 3 pixels a frame.
fn motionColor(point: vec3f) -> vec3f {
  let m = motionVector(point);
  let hue = (atan2(m.y, m.x) / (2.0 * PI)) + 1.0;
  let rgb = clamp(abs(fract(hue + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return rgb * (1.0 - exp(-length(m) / 4.0));
}

// VIEW_RAYS, on a doubling scale: 1 ray blue, 2 teal, 4 green, 8 yellow,
// 16 or more red. Fractions (from averaging samples) land in between.
fn heat(rays: f32) -> vec3f {
  var palette = array<vec3f, 5>(
    vec3f(0.05, 0.1, 0.5),
    vec3f(0.0, 0.55, 0.65),
    vec3f(0.15, 0.7, 0.2),
    vec3f(0.95, 0.8, 0.1),
    vec3f(0.9, 0.15, 0.1),
  );
  let position = clamp(log2(max(rays, 1.0)), 0.0, 3.999);
  let i = u32(position);
  return mix(palette[i], palette[i + 1u], fract(position));
}

// ---- Accumulation --------------------------------------------------------
// One record per pixel, row by row, kept from sample to sample. Its size
// follows the canvas (tracer-pass.ts). If the canvas is too big for one
// buffer, it holds a single record and the image doesn't refine.
//
// There are two copies, which take turns: each frame reads last frame's
// (`history`) and writes a new one (`pixels`). While the camera stands still
// each pixel reads only its own record, and one copy would do. Once the
// camera moves, a pixel will read its record from wherever its point was
// last frame (C2's temporal steps), so it mustn't overwrite records that its
// neighbors are still reading: hence two, like a game's double-buffered
// screen ("ping-pong").
//
// Besides the running total of light, each record keeps what the denoiser
// (denoise.wgsl) needs to tell noise from detail: the sum of each sample's
// brightness squared, to work out how noisy the pixel still is, and what the
// pixel shows (a "G-buffer": surface color, facing and distance). The copy of
// this struct in denoise.wgsl must match (denoise.test.ts checks).
//
// Samples come in two kinds, totalled apart (see isNoiseFree and
// screenColor): noise-free ones, whose camera ray went straight to a light or
// the sky, and the rest. The rest is what the denoiser works on.
struct PixelRecord {
  light: vec4f, // the rest: rgb, running total of light (or a debug view's value); a, of luminance(light)²
  albedo: vec4f, // the rest: rgb, running total of the first surface's color (firstColor); a, how many samples in all
  surface: vec4f, // firstSurface (negative distance: seen in a mirror): kept from the first sample that hit one, unless the camera moved
  noiseFree: vec4f, // the noise-free samples: rgb, running total of their screen colors (toneMap); a, how many
}

@group(0) @binding(4) var<storage, read> history: array<PixelRecord>;
// 9 is the last binding a fragment shader can have by default: WebGPU allows
// 8 storage buffers per shader stage (maxStorageBuffersPerShaderStage), and
// this is the 8th. https://www.w3.org/TR/webgpu/#limits
@group(0) @binding(9) var<storage, read_write> pixels: array<PixelRecord>;

// How bright a color looks: green counts most, blue least (Rec. 709 weights).
// https://en.wikipedia.org/wiki/Relative_luminance
fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

// ---- Output --------------------------------------------------------------
// Squeezes unbounded brightness into 0..1 with a gentle film-like curve,
// instead of clipping everything above 1 to white. ACES curve fit by
// Krzysztof Narkowicz: https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
fn toneMap(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

// The canvas texture format is plain 8-bit "bgra8unorm" or "rgba8unorm"
// (what getPreferredCanvasFormat() returns), not an -srgb format, so the GPU
// won't apply the sRGB curve for us. Displays expect sRGB-encoded values;
// writing linear light directly would look too dark and harsh.
// https://www.w3.org/TR/webgpu/#dom-gpu-getpreferredcanvasformat
fn encodeSrgb(linear: vec3f) -> vec3f {
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

// ---- Bright edges --------------------------------------------------------
// Averaging light and then tone mapping is right for noise, but crushes the
// edge of anything very bright. A ceiling panel is ~13 times as bright as the
// ceiling, so a pixel a quarter covered by it averages to 1.1, which tone
// mapping shows at 80% of white: the panel's soft edge collapses into one
// pixel, and an edge at an angle becomes a staircase. Averaging screen colors
// instead gives a true blend, a quarter of the way from ceiling to panel, as
// a game's anti-aliasing would. But doing that for noisy samples would darken
// them: tone mapping is a curve, and the average of a curve's values isn't
// the curve at the average (Jensen's inequality). So it's done only for
// samples with no noise in them. Games use a related trick, the "Karis
// resolve"; offline renderers such as V-Ray call it sub-pixel mapping.
//
// It has a cost: averaging screen colors caps each sample at white, so a
// glint smaller than a pixel loses the light that made it show. Tried on
// everything that reaches a light, the pink and white glints on neon-night's
// chrome balls all but vanished. So it's only for lights and sky the camera
// sees directly, which are large enough to have edges.

// Whether this sample's value came out the same whatever the random numbers
// were, apart from where in the pixel it landed, and should be averaged as a
// screen color: the path tracer's camera ray went straight to a light or the
// sky. Only for the final image (debug views aren't light), and not for the
// Whitted renderer, whose glints in mirrors would fade the same way.
fn isNoiseFree() -> bool {
  return showsLight() && frame.renderer == RENDERER_PATH && directGlow;
}

// The views that trace light and keep its running totals: the final image,
// and the history-length view, which shows how many samples it holds.
fn showsLight() -> bool {
  return frame.view == VIEW_FINAL || frame.view == VIEW_HISTORY;
}

// A pixel's color for the screen, over `count` samples: the noise-free ones'
// average screen color and the rest's average light, tone mapped, blended by
// how many samples each has. `restMean` is the rest's average light (maybe
// denoised). With no noise-free samples, it's just the tone-mapped average.
// denoise.wgsl has a copy (denoise.test.ts checks they match).
//
// Exposure scales the light first, as a camera's shutter and aperture do:
// the scene stays as it is, only how much of its light reaches the picture
// changes. The noise-free samples were already scaled when they were added.
fn screenColor(restMean: vec3f, noiseFree: vec4f, count: f32) -> vec3f {
  if (noiseFree.a == 0.0) {
    return encodeSrgb(toneMap(restMean * frame.exposure));
  }
  let rest = count - noiseFree.a;
  var sum = noiseFree.rgb;
  if (rest > 0.0) {
    sum += rest * toneMap(restMean * frame.exposure);
  }
  return encodeSrgb(sum / count);
}

@fragment
fn fs(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  // pixel.xy is this pixel's center in canvas pixels: origin top-left, y
  // down. Its integer part says which pixel this is.
  let pixelIndex = vec2u(pixel.xy);
  seedRandom(pixelIndex, frame.sampleIndex);

  // Anti-aliasing. A pixel covers a small square of the scene, not a point.
  // The first sample goes through its center, as in C0, so a moving camera
  // looks steady. Later samples go through random points in the square, and
  // averaging them gives the pixel the average color of everything in it.
  var position = pixel.xy;
  if (frame.sampleIndex > 0u) {
    position = vec2f(pixelIndex) + vec2f(random(), random());
  }

  // Map the position to -1..1 on both axes with +y up.
  let ndc = vec2f(
    position.x / frame.resolution.x * 2.0 - 1.0,
    1.0 - position.y / frame.resolution.y * 2.0,
  );
  // Aim through that point on an imaginary screen one unit in front of the
  // camera. Its half-height is tan(fov/2); half-width is that × aspect.
  let dir = normalize(
    frame.cameraForward
      + frame.cameraRight * (ndc.x * frame.tanHalfFovY * frame.aspect)
      + frame.cameraUp * (ndc.y * frame.tanHalfFovY),
  );
  let ray = Ray(frame.cameraPos, dir);

  // This sample's value: light for the final image, the number of rays for
  // VIEW_RAYS, or a debug view's false color.
  rayCount = 0u;
  firstColor = vec3f(0.0);
  firstSurface = vec4f(0.0, 0.0, 0.0, NO_HIT);
  firstDepth = NO_HIT;
  directGlow = false;
  var value: vec3f;
  if (showsLight() || frame.view == VIEW_RAYS) {
    var light: vec3f;
    if (frame.renderer == RENDERER_PATH) {
      light = tracePath(ray);
    } else {
      light = traceWhitted(ray);
    }
    value = select(light, vec3f(f32(rayCount)), frame.view == VIEW_RAYS);
  } else {
    value = debugView(ray);
  }

  // This sample, as a record of one: a noise-free sample's screen color goes
  // in one total, the rest's light in the other (PixelRecord, screenColor).
  var record = PixelRecord(
    vec4f(value, luminance(value) * luminance(value)),
    vec4f(firstColor, 1.0),
    firstSurface,
    vec4f(0.0),
  );
  if (isNoiseFree()) {
    record.noiseFree = vec4f(toneMap(value * frame.exposure), 1.0);
    record.light = vec4f(0.0);
  }

  // Add it to the pixel's history, and show the average.
  let slot = pixelIndex.y * u32(frame.resolution.x) + pixelIndex.x;
  if (slot < arrayLength(&pixels)) {
    if (frame.sampleIndex > 0u) {
      if (frame.cameraMoved == 0u) {
        // Standing still: the pixel's own record, as in C1.
        let earlier = history[slot];
        record.light += earlier.light;
        record.albedo += earlier.albedo;
        record.noiseFree += earlier.noiseFree;
        // Keep the surface found first. Where the center ray hit a light,
        // the denoiser still needs the surface beside it, from the first
        // jittered ray that found it.
        if (firstSurface.w >= NO_HIT || earlier.surface.w < NO_HIT) {
          record.surface = earlier.surface;
        }
      } else if (showsLight() && frame.renderer == RENDERER_PATH) {
        // Moving: carry on from where this point was last frame, if that
        // was the same surface. Otherwise it just came into view, and the
        // pixel starts over from this sample.
        let depth = select(firstDepth, FAR_AWAY, firstDepth >= NO_HIT);
        let point = ray.origin + ray.dir * depth;
        let earlier = reproject(point, firstSurface);
        if (earlier.found) {
          var history = earlier.record;
          if (firstSurface.w < NO_HIT) {
            history = recolored(history, firstColor);
          }
          record.light += history.light;
          record.albedo += history.albedo;
          record.noiseFree += history.noiseFree;
        }
        record.surface = surfaceForCenter(firstSurface, point, pixelIndex);
      }
      // The other renderer and views start over after a move, as before:
      // they have little noise to hide, and nothing to reproject them by.
    }
    pixels[slot] = record;
  }

  let count = record.albedo.a;
  if (frame.view == VIEW_FINAL) {
    // A pixel whose samples all hit surfaces (most of them) has rest = count,
    // so this is exactly the plain average, tone mapped, as in C1.
    let rest = count - record.noiseFree.a;
    return vec4f(screenColor(record.light.rgb / max(rest, 1.0), record.noiseFree, count), 1.0);
  }
  if (frame.view == VIEW_HISTORY) {
    // On the rays view's doubling scale, by the square root, so it reaches
    // further: 1 sample blue, 4 teal, 16 green, 64 yellow, 256 or more red.
    return vec4f(heat(sqrt(count)), 1.0);
  }
  // The debug views are averaged as they are: they're not light.
  var color = record.light.rgb / count;
  if (frame.view == VIEW_RAYS) {
    color = heat(color.x); // the average number of rays per sample
  }
  return vec4f(color, 1.0);
}
