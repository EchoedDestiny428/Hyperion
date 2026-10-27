// C0: a Whitted-style ray tracer (Turner Whitted, 1980).
// Every pixel shoots one ray from the camera. Where it hits a matte surface
// we shoot a second "shadow ray" toward the sun to see if anything blocks it;
// mirror surfaces bounce the ray onward. WGSL spec: https://www.w3.org/TR/WGSL/

// Must match packFrameUniforms() in frame-uniforms.ts. A vec3f is aligned to
// 16 bytes, so an f32 sits in each vec3f's spare 4 bytes.
// https://www.w3.org/TR/WGSL/#alignment-and-size
struct Frame {
  cameraPos: vec3f,
  tanHalfFovY: f32,
  cameraRight: vec3f,
  aspect: f32,
  cameraUp: vec3f,
  time: f32,
  cameraForward: vec3f,
  _pad0: f32,
  resolution: vec2f,
  _pad1: vec2f,
}

@group(0) @binding(0) var<uniform> frame: Frame;

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
  groundMaterial: u32, // index into materials
  _pad: vec2u,
}

struct Sphere {
  center: vec3f,
  radius: f32,
  material: u32, // index into materials
  // WGSL pads this struct from 20 to 32 bytes: a struct holding a vec3f is
  // aligned to 16 bytes, and its size rounds up to match.
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
}

// A uniform buffer is small and fixed-size. Storage buffers can be large, and
// an array in one needs no fixed length (array<Sphere>, not array<Sphere, 5>),
// so the same shader handles any number of objects.
@group(0) @binding(1) var<uniform> scene: SceneInfo;
@group(0) @binding(2) var<storage, read> spheres: array<Sphere>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;

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

const SUN_COLOR = vec3f(1.6, 1.52, 1.36); // brighter than 1: tone mapping handles it

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

fn intersectGround(ray: Ray) -> f32 {
  // The plane y = 0. Only rays heading downward can reach it.
  if (ray.dir.y > -1e-6) {
    return NO_HIT;
  }
  let t = -ray.origin.y / ray.dir.y;
  return select(NO_HIT, t, t > EPSILON);
}

// Finds the closest thing the ray hits, by testing every object. Fine for a
// handful of objects; a real scene needs an acceleration structure (a BVH, Act 2).
fn intersectScene(ray: Ray) -> Hit {
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
  hit.position = ray.origin + hit.t * ray.dir;
  return hit;
}

// ---- Lighting ------------------------------------------------------------
fn sunDirection() -> vec3f {
  // The sun circles slowly so the shadows visibly move: proof they're
  // computed live, every frame, not baked into the scene.
  let angle = frame.time * 0.15;
  return normalize(vec3f(cos(angle), 0.9, sin(angle)));
}

fn sky(dir: vec3f, toSun: vec3f) -> vec3f {
  let horizon = vec3f(0.62, 0.74, 0.9);
  let zenith = vec3f(0.1, 0.27, 0.7);
  var color = mix(horizon, zenith, sqrt(max(dir.y, 0.0)));
  let towardSun = dot(dir, toSun); // 1 when looking straight at the sun
  color += SUN_COLOR * 4.0 * smoothstep(0.9995, 0.9998, towardSun); // the disk
  color += SUN_COLOR * 0.15 * pow(max(towardSun, 0.0), 64.0); // glow around it
  return color;
}

fn inShadow(position: vec3f, normal: vec3f, toSun: vec3f) -> bool {
  let shadowRay = Ray(position + normal * EPSILON, toSun);
  return intersectScene(shadowRay).t < NO_HIT;
}

fn diffuseAlbedo(material: Material, position: vec3f) -> vec3f {
  if (material.kind == KIND_CHECKER) {
    // Squares cellSize wide: the parity of the integer square coordinates
    // picks the color.
    let cell = vec2i(floor(position.xz / material.cellSize));
    return select(material.colorA, material.colorB, ((cell.x + cell.y) & 1) == 1);
  }
  return material.colorA;
}

const MAX_BOUNCES = 4;

fn trace(primary: Ray) -> vec3f {
  let toSun = sunDirection();
  var ray = primary;
  // How much of the light found further along reaches the camera. Starts at
  // 1 and is reduced by each mirror bounce (no mirror is perfect).
  var throughput = vec3f(1.0);

  for (var bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    let hit = intersectScene(ray);
    if (hit.t >= NO_HIT) {
      return throughput * sky(ray.dir, toSun);
    }

    let material = materials[hit.material];
    if (material.kind == KIND_MIRROR) {
      // Perfect mirror: reflect the direction about the normal and continue.
      throughput *= material.colorA; // the tint
      ray = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
      continue;
    }

    // Matte surface. Lambert's cosine law: light arriving at a grazing angle
    // spreads over more area, so the surface looks dimmer.
    let cosine = max(dot(hit.normal, toSun), 0.0);
    var direct = vec3f(0.0);
    if (cosine > 0.0 && !inShadow(hit.position, hit.normal, toSun)) {
      direct = SUN_COLOR * cosine;
    }
    // Whitted ray tracing has no bounce light, so light arriving from the sky
    // and from other surfaces is faked with a constant "ambient" term.
    // C1's path tracer computes it for real.
    let ambient = vec3f(0.16, 0.2, 0.28) * (0.5 + 0.5 * hit.normal.y);
    var surface = diffuseAlbedo(material, hit.position) * (direct + ambient);
    // Fade distant surfaces into the sky color. This hides the checkerboard
    // flickering near the horizon, since there's no anti-aliasing yet (C1).
    surface = mix(surface, sky(ray.dir, toSun), 1.0 - exp(-hit.t * 0.012));
    return throughput * surface;
  }
  return vec3f(0.0); // ran out of bounces between mirrors
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

@fragment
fn fs(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  // pixel.xy is this pixel's center in canvas pixels: origin top-left, y
  // down. Map it to -1..1 on both axes with +y up.
  let ndc = vec2f(
    pixel.x / frame.resolution.x * 2.0 - 1.0,
    1.0 - pixel.y / frame.resolution.y * 2.0,
  );
  // Aim through that point on an imaginary screen one unit in front of the
  // camera. Its half-height is tan(fov/2); half-width is that × aspect.
  let dir = normalize(
    frame.cameraForward
      + frame.cameraRight * (ndc.x * frame.tanHalfFovY * frame.aspect)
      + frame.cameraUp * (ndc.y * frame.tanHalfFovY),
  );
  let color = trace(Ray(frame.cameraPos, dir));
  return vec4f(encodeSrgb(toneMap(color)), 1.0);
}
