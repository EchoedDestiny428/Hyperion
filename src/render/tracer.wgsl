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
}

const NO_GROUND = 4294967295u; // 0xffffffff: this scene has no ground plane

struct Sphere {
  center: vec3f,
  radius: f32,
  material: u32, // index into materials
  // WGSL pads this struct from 20 to 32 bytes: a struct holding a vec3f is
  // aligned to 16 bytes, and its size rounds up to match.
}

struct Box {
  center: vec3f,
  material: u32,
  halfSize: vec3f, // half the width, height and depth, before rotating
  rotation: mat3x3f, // columns: where the box's own x, y and z axes point
}

// Material kinds. Must match MATERIAL_KIND in scene/scene.ts (scene.test.ts checks).
const KIND_DIFFUSE = 0u; // matte, colored by colorA
const KIND_MIRROR = 1u; // perfect reflection, tinted by colorA
const KIND_CHECKER = 2u; // matte squares of colorA and colorB, cellSize meters wide

struct Material {
  colorA: vec3f,
  kind: u32,
  colorB: vec3f,
  cellSize: f32,
  emission: vec3f, // light it gives off by itself; black for most materials
  reflectivity: f32, // matte kinds: the share reflected like a mirror coat
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
}

const NO_HIT = 1e30;
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

struct BoxHit {
  t: f32,
  normal: vec3f,
}

fn intersectBox(ray: Ray, box: Box) -> BoxHit {
  // Move the ray into the box's own coordinates, where the box is centered
  // at the origin and lined up with the axes: undo the move, then the
  // rotation. A rotation matrix's inverse is its transpose, and `v * m`
  // multiplies by the transpose.
  let origin = (ray.origin - box.center) * box.rotation;
  var dir = ray.dir * box.rotation;
  // WGSL doesn't promise that dividing by zero gives infinity, so nudge zero
  // components to a tiny number instead. https://www.w3.org/TR/WGSL/#floating-point-evaluation
  dir = select(dir, vec3f(1e-20), abs(dir) < vec3f(1e-20));

  // The "slab" test (Kay & Kajiya, 1986). The box is where three slabs
  // overlap, each the space between two parallel planes. Along each axis the
  // ray is inside that slab from tNear to tFar; it's inside the box from the
  // last of the entries to the first of the exits.
  let tA = (-box.halfSize - origin) / dir;
  let tB = (box.halfSize - origin) / dir;
  let entries = min(tA, tB);
  let exits = max(tA, tB);
  let tEnter = max(max(entries.x, entries.y), entries.z);
  let tExit = min(min(exits.x, exits.y), exits.z);
  var hit = BoxHit(NO_HIT, vec3f(0.0));
  if (tEnter > tExit || tExit < EPSILON) {
    return hit; // the slabs never overlap along the ray, or the box is behind it
  }
  hit.t = select(tEnter, tExit, tEnter < EPSILON); // starting inside: where the ray leaves

  // The face hit is the one the hit point is closest to, relative to the
  // box's size along each axis.
  let p = origin + hit.t * dir;
  let q = abs(p) / box.halfSize;
  var n = vec3f(0.0);
  if (q.x >= q.y && q.x >= q.z) {
    n.x = sign(p.x);
  } else if (q.y >= q.z) {
    n.y = sign(p.y);
  } else {
    n.z = sign(p.z);
  }
  hit.normal = box.rotation * n; // back to world directions
  return hit;
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

// Finds the closest thing the ray hits, by testing every object. Fine for a
// few dozen objects; a real scene needs an acceleration structure (a BVH, Act 2).
fn intersectScene(ray: Ray) -> Hit {
  rayCount++;
  var hit: Hit;
  hit.t = intersectGround(ray);
  hit.normal = vec3f(0.0, 1.0, 0.0);
  hit.material = scene.groundMaterial;
  for (var i = 0u; i < scene.sphereCount; i++) {
    let sphere = spheres[i];
    let t = intersectSphere(ray, sphere);
    if (t < hit.t) {
      hit.t = t;
      hit.normal = normalize(ray.origin + t * ray.dir - sphere.center);
      hit.material = sphere.material;
    }
  }
  for (var i = 0u; i < scene.boxCount; i++) {
    let box = boxes[i];
    let boxHit = intersectBox(ray, box);
    if (boxHit.t < hit.t) {
      hit.t = boxHit.t;
      hit.normal = boxHit.normal;
      hit.material = box.material;
    }
  }
  hit.position = ray.origin + hit.t * ray.dir;
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

// A random number in [0, 1). Uses the top 24 bits, because an f32 holds 24
// bits exactly; converting all 32 could round up to 1.0.
fn random() -> f32 {
  rngState = pcgHash(rngState);
  return f32(rngState >> 8u) / 16777216.0;
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

fn sunDirection() -> vec3f {
  // The sun can circle ("Sun moves") to show that shadows are computed live.
  let angle = frame.time * 0.15;
  return normalize(vec3f(cos(angle), 0.9, sin(angle)));
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

// The light arriving from direction `dir`. `withSunDisk` is false for rays
// leaving a matte surface in the path tracer: its shadow rays already count
// the sun, and counting the disk again would add the sunlight twice.
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

// Picks a light in proportion to the light it gives off (findLights() in
// scene.ts sets the odds), then a point spread evenly over its surface.
fn sampleLight() -> LightSample {
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
    // A box: pick one of its six faces in proportion to its area, then a
    // point on that face, in the box's own coordinates.
    let box = boxes[picked.index];
    let h = box.halfSize;
    let faceAreas = vec3f(h.y * h.z, h.x * h.z, h.x * h.y) * 4.0; // the faces across x, y and z
    s.area = 2.0 * (faceAreas.x + faceAreas.y + faceAreas.z);
    let side = select(-1.0, 1.0, random() < 0.5);
    let along = vec2f(random(), random()) * 2.0 - 1.0; // -1..1 across the face
    let pick = random() * (faceAreas.x + faceAreas.y + faceAreas.z);
    var local: vec3f;
    var n: vec3f;
    if (pick < faceAreas.x) {
      local = vec3f(side * h.x, along.x * h.y, along.y * h.z);
      n = vec3f(side, 0.0, 0.0);
    } else if (pick < faceAreas.x + faceAreas.y) {
      local = vec3f(along.x * h.x, side * h.y, along.y * h.z);
      n = vec3f(0.0, side, 0.0);
    } else {
      local = vec3f(along.x * h.x, along.y * h.y, side * h.z);
      n = vec3f(0.0, 0.0, side);
    }
    s.position = box.center + box.rotation * local;
    s.normal = box.rotation * n;
    s.emission = materials[box.material].emission;
  }
  return s;
}

// The light one glowing object adds to a matte point, estimated from one
// random point on it. Light from a small patch of the glowing surface falls
// off with the square of the distance, and with the angle at each end: a
// surface facing the light at a slant catches less of it (cosSurface), and
// a patch seen edge-on shows less of itself (cosLight).
fn lightFromObjects(position: vec3f, normal: vec3f) -> vec3f {
  if (scene.lightCount == 0u) {
    return vec3f(0.0);
  }
  let s = sampleLight();
  let toLight = s.position - position;
  let distanceSquared = dot(toLight, toLight);
  let distance = sqrt(distanceSquared);
  let dir = toLight / distance;
  let cosSurface = dot(normal, dir);
  let cosLight = -dot(s.normal, dir);
  if (cosSurface <= 0.0 || cosLight <= 0.0) {
    return vec3f(0.0); // the point faces away, or the patch faces away from the point
  }
  // Stop just short of the light, so its own surface doesn't count as a blocker.
  if (blocked(position, normal, dir, distance * (1.0 - 1e-3))) {
    return vec3f(0.0);
  }
  // Dividing by the chance of picking this light and this point (1/area)
  // makes the estimate right on average. The 1/π belongs to a matte surface,
  // which spreads what it reflects over a hemisphere.
  return s.emission * cosSurface * cosLight * s.area / (PI * distanceSquared * s.probability);
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
// The color a surface reflects: a matte surface's albedo, or a mirror's tint.
fn surfaceColor(material: Material, position: vec3f) -> vec3f {
  if (material.kind == KIND_CHECKER) {
    // Squares cellSize wide: the parity of the integer square coordinates
    // picks the color.
    let cell = vec2i(floor(position.xz / material.cellSize));
    return select(material.colorA, material.colorB, ((cell.x + cell.y) & 1) == 1);
  }
  return material.colorA;
}

// Fade distant surfaces into the sky color, like haze. In C0 it also hid the
// checkerboard flickering near the horizon; anti-aliasing now fixes that.
fn haze(surface: vec3f, distance: f32, dir: vec3f, toSun: vec3f) -> vec3f {
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
    let reflected = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
    if (material.kind == KIND_MIRROR) {
      // Perfect mirror: reflect the direction about the normal and continue.
      throughput *= material.colorA; // the tint
      ray = reflected;
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
    let surface = surfaceColor(material, hit.position) * (direct + ambient);
    // A mirror coat reflects part of the light; the rest is the matte color.
    let coat = material.reflectivity;
    color += throughput * (1.0 - coat) * haze(surface, hit.t, ray.dir, toSun);
    if (coat <= 0.0) {
      return color;
    }
    throughput *= coat;
    ray = reflected;
  }
  return color; // ran out of bounces between mirrors
}

// ---- Renderer 2: path tracer (C1) ----------------------------------------
// Follows one random path of light backwards from the camera. At each matte
// surface it adds the light arriving there directly from the sun and the
// glowing objects (via shadow rays) and then bounces on in a random
// direction, until the path escapes to the sky (which adds the sky's light)
// or ends.
const MAX_PATH_BOUNCES = 8u;

fn tracePath(primary: Ray) -> vec3f {
  let toSun = sunDirection();
  var ray = primary;
  var throughput = vec3f(1.0);
  var light = vec3f(0.0); // gathered so far
  var firstHitDistance = NO_HIT;
  // Whether this ray should count light sources it hits directly: true for
  // camera rays and mirror reflections, false after a matte bounce, whose
  // shadow rays already counted them (the same rule as the sun disk in sky()).
  var countLights = true;

  for (var bounce = 0u; bounce < MAX_PATH_BOUNCES; bounce++) {
    let hit = intersectScene(ray);
    if (bounce == 0u) {
      firstHitDistance = hit.t;
    }
    if (hit.t >= NO_HIT) {
      // The path escaped: the sky is a light source, so whatever it shows in
      // this direction is light arriving along the path.
      light += throughput * sky(ray.dir, toSun, countLights);
      break;
    }

    let material = materials[hit.material];
    if (countLights) {
      light += throughput * material.emission;
    }
    let reflected = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
    if (material.kind == KIND_MIRROR) {
      throughput *= material.colorA;
      ray = reflected;
      countLights = true;
      continue;
    }

    // Matte surface, possibly with a mirror coat that reflects a share
    // `coat` of the light. The matte part gets (1 - coat) of everything.
    let coat = material.reflectivity;
    let albedo = surfaceColor(material, hit.position);

    // First, light arriving directly, through shadow rays: one toward a
    // random point on the sun ("next-event estimation") and one toward a
    // random point on a glowing object. Only sending bounce rays would find
    // the tiny sun or a small lamp by chance, almost never.
    let sunRay = sampleSunDirection(toSun);
    let cosine = dot(hit.normal, sunRay);
    var direct = lightFromObjects(hit.position, hit.normal);
    if (cosine > 0.0 && !inShadow(hit.position, hit.normal, sunRay)) {
      direct += scene.sunColor * cosine;
    }
    light += throughput * (1.0 - coat) * albedo * direct;

    // Then continue the path. With probability `coat` it reflects off the
    // coat like a mirror; otherwise it bounces off the matte surface. Choosing
    // one at random, with exactly those odds, is right on average.
    if (random() < coat) {
      ray = reflected;
      countLights = true; // the coat's reflection of a light isn't covered by shadow rays
      continue;
    }

    // A matte surface scatters light more toward its normal than sideways
    // (Lambert's cosine law again), so directions near the normal are chosen
    // more often: a random point on a unit sphere resting on the surface gives
    // exactly that spread ("cosine-weighted"). With the directions spread that
    // way, each bounce just multiplies by the albedo.
    let scatter = hit.normal + randomUnitVector();
    let dir = select(normalize(scatter), hit.normal, dot(scatter, scatter) < 1e-8);
    throughput *= albedo;
    ray = Ray(hit.position + hit.normal * EPSILON, dir);
    countLights = false;

    // Russian roulette: after a few bounces, end paths at random, more often
    // the less light they can still carry, and brighten the survivors to make
    // up for it. On average the result is unchanged, but little time goes on
    // paths that hardly matter.
    if (bounce >= 2u) {
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
      return select(vec3f(0.0), tint * sky(ray.dir, toSun, true), frame.view == VIEW_COLOR);
    }
    travelled += hit.t;
    let material = materials[hit.material];
    if (material.kind == KIND_MIRROR) {
      tint *= material.colorA;
      ray = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
      continue;
    }
    switch frame.view {
      case VIEW_COLOR: {
        return tint * surfaceColor(material, hit.position); // the albedo
      }
      case VIEW_NORMALS: {
        return hit.normal * 0.5 + 0.5; // each axis from -1..1 to 0..1
      }
      case VIEW_DISTANCE: {
        return vec3f(exp(-travelled * 0.1)); // near is bright, far fades to black
      }
      default: {
        return sunlightView(hit, toSun);
      }
    }
  }
  return vec3f(0.0);
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
// The running total of samples for each pixel, one vec4f per pixel, row by
// row. Its size follows the canvas (tracer-pass.ts). If the canvas is too
// big for one buffer, it holds a single element and the image doesn't refine.
@group(0) @binding(4) var<storage, read_write> accumulation: array<vec4f>;

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
  var value: vec3f;
  if (frame.view == VIEW_FINAL || frame.view == VIEW_RAYS) {
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

  // Add the value to the pixel's running total and show the average. For
  // the final image the average is taken before tone mapping: averaging
  // light, not finished screen colors, is what makes a half-covered edge
  // pixel look right.
  var total = value;
  var count = 1.0;
  let slot = pixelIndex.y * u32(frame.resolution.x) + pixelIndex.x;
  if (slot < arrayLength(&accumulation)) {
    if (frame.sampleIndex > 0u) {
      total += accumulation[slot].rgb;
      count = f32(frame.sampleIndex + 1u);
    }
    accumulation[slot] = vec4f(total, 0.0);
  }
  var color = total / count;

  // Only the final image is light that needs converting for the screen.
  if (frame.view == VIEW_FINAL) {
    color = encodeSrgb(toneMap(color));
  } else if (frame.view == VIEW_RAYS) {
    color = heat(color.x); // the average number of rays per sample
  }
  return vec4f(color, 1.0);
}
