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
  layers: u32, // bit flags: which LAYER_* are on
  resolution: vec2f,
  view: u32, // one of VIEW_*
  _pad: f32,
}

@group(0) @binding(0) var<uniform> frame: Frame;

// ---- Layers and views ----------------------------------------------------
// Switches for seeing what each part of the shader contributes, set from the
// Layers panel. Must match LAYER_BITS and VIEWS in layers.ts (layers.test.ts checks).
const LAYER_SUN = 1u; // direct sunlight
const LAYER_SHADOWS = 2u; // shadow rays; off, the sun shines through objects
const LAYER_AMBIENT = 4u; // the fake fill light
const LAYER_COLOR = 8u; // material colors; off, every surface is grey
const LAYER_REFLECTIONS = 16u; // mirror bounces; off, mirrors are matte
const LAYER_FOG = 32u; // distant surfaces fade into the sky
const LAYER_SKY = 64u; // off, rays that hit nothing return black
const LAYER_TONE_MAP = 128u; // off, brightness above 1 clips to white
const LAYER_SRGB = 256u; // off, linear light goes to the screen unconverted

fn layerOn(layer: u32) -> bool {
  return (frame.layers & layer) != 0u;
}

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

// What a ray sees when it hits nothing.
fn background(dir: vec3f, toSun: vec3f) -> vec3f {
  if (!layerOn(LAYER_SKY)) {
    return vec3f(0.0);
  }
  return sky(dir, toSun);
}

// The sun is a direction, not a point: it's so far away that all shadow rays
// are parallel, and anything the ray hits counts as blocking it.
fn inShadow(position: vec3f, normal: vec3f, toSun: vec3f) -> bool {
  let shadowRay = Ray(position + normal * EPSILON, toSun);
  return intersectScene(shadowRay).t < NO_HIT;
}

// The color a surface reflects: a matte surface's albedo, or a mirror's tint.
fn surfaceColor(material: Material, position: vec3f) -> vec3f {
  if (!layerOn(LAYER_COLOR)) {
    // Plain grey "clay", which shows the lighting on its own.
    return select(vec3f(0.7), vec3f(0.9), material.kind == KIND_MIRROR);
  }
  if (material.kind == KIND_CHECKER) {
    // Squares cellSize wide: the parity of the integer square coordinates
    // picks the color.
    let cell = vec2i(floor(position.xz / material.cellSize));
    return select(material.colorA, material.colorB, ((cell.x + cell.y) & 1) == 1);
  }
  return material.colorA;
}

// VIEW_SUNLIGHT: the two ways a point can miss the sun. It ignores the layer
// switches, so it always shows where the scene's shadows really fall.
fn sunlightView(hit: Hit, toSun: vec3f) -> vec3f {
  if (dot(hit.normal, toSun) <= 0.0) {
    return vec3f(0.1, 0.15, 0.45); // blue: faces away from the sun, so no shadow ray is needed
  }
  if (inShadow(hit.position, hit.normal, toSun)) {
    return vec3f(1.0, 0.45, 0.1); // orange: the shadow ray hit something (a cast shadow)
  }
  return vec3f(1.0); // white: the sun reaches it
}

// VIEW_RAYS: 1 ray blue, 2 teal, 3 green, 4 yellow, 5 red.
fn heat(rays: u32) -> vec3f {
  var palette = array<vec3f, 5>(
    vec3f(0.05, 0.1, 0.5),
    vec3f(0.0, 0.55, 0.65),
    vec3f(0.15, 0.7, 0.2),
    vec3f(0.95, 0.8, 0.1),
    vec3f(0.9, 0.15, 0.1),
  );
  return palette[clamp(rays, 1u, 5u) - 1u];
}

const MAX_BOUNCES = 4;

fn trace(primary: Ray) -> vec3f {
  let toSun = sunDirection();
  var ray = primary;
  // How much of the light found further along reaches the camera. Starts at
  // 1 and is reduced by each mirror bounce (no mirror is perfect).
  var throughput = vec3f(1.0);
  var rays = 0u; // rays traced for this pixel so far, for VIEW_RAYS
  var travelled = 0.0; // total path length so far, for VIEW_DISTANCE

  for (var bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    let hit = intersectScene(ray);
    rays++;
    if (hit.t >= NO_HIT) {
      switch frame.view {
        case VIEW_FINAL, VIEW_COLOR: {
          return throughput * background(ray.dir, toSun);
        }
        case VIEW_RAYS: {
          return heat(rays);
        }
        default: {
          return vec3f(0.0);
        }
      }
    }
    travelled += hit.t;

    let material = materials[hit.material];
    if (material.kind == KIND_MIRROR && layerOn(LAYER_REFLECTIONS)) {
      // Perfect mirror: reflect the direction about the normal and continue.
      throughput *= surfaceColor(material, hit.position); // the tint
      ray = Ray(hit.position + hit.normal * EPSILON, reflect(ray.dir, hit.normal));
      continue;
    }

    // A matte surface (or a mirror, with reflections off): the path ends here.
    let albedo = surfaceColor(material, hit.position);

    // Sunlight. Lambert's cosine law: light arriving at a grazing angle
    // spreads over more area, so the surface looks dimmer. A surface facing
    // away from the sun (cosine 0) gets none, so it needs no shadow ray.
    let cosine = max(dot(hit.normal, toSun), 0.0);
    var direct = vec3f(0.0);
    if (layerOn(LAYER_SUN) && cosine > 0.0) {
      var blocked = false;
      if (layerOn(LAYER_SHADOWS)) {
        blocked = inShadow(hit.position, hit.normal, toSun);
        rays++;
      }
      if (!blocked) {
        direct = SUN_COLOR * cosine;
      }
    }

    // Whitted ray tracing has no bounce light, so light arriving from the sky
    // and from other surfaces is faked with a constant "ambient" term.
    // C1's path tracer computes it for real.
    var ambient = vec3f(0.0);
    if (layerOn(LAYER_AMBIENT)) {
      ambient = vec3f(0.16, 0.2, 0.28) * (0.5 + 0.5 * hit.normal.y);
    }

    var surface = albedo * (direct + ambient);
    if (layerOn(LAYER_FOG)) {
      // Fade distant surfaces into the sky color. This hides the checkerboard
      // flickering near the horizon, since there's no anti-aliasing yet (C1).
      surface = mix(surface, background(ray.dir, toSun), 1.0 - exp(-hit.t * 0.012));
    }

    switch frame.view {
      case VIEW_COLOR: {
        return throughput * albedo;
      }
      case VIEW_NORMALS: {
        return hit.normal * 0.5 + 0.5; // each axis from -1..1 to 0..1
      }
      case VIEW_DISTANCE: {
        return vec3f(exp(-travelled * 0.1)); // near is bright, far fades to black
      }
      case VIEW_SUNLIGHT: {
        return sunlightView(hit, toSun);
      }
      case VIEW_RAYS: {
        return heat(rays);
      }
      default: {
        return throughput * surface;
      }
    }
  }
  // Ran out of bounces between mirrors.
  if (frame.view == VIEW_RAYS) {
    return heat(rays);
  }
  return vec3f(0.0);
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
  var color = trace(Ray(frame.cameraPos, dir));
  // Only the final image is light that needs converting for the screen; the
  // other views are already display colors.
  if (frame.view == VIEW_FINAL) {
    if (layerOn(LAYER_TONE_MAP)) {
      color = toneMap(color);
    } else {
      color = min(color, vec3f(1.0)); // the screen can't show more than 1
    }
    if (layerOn(LAYER_SRGB)) {
      color = encodeSrgb(color);
    }
  }
  return vec4f(color, 1.0);
}
