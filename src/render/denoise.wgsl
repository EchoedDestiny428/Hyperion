// The denoiser (C2): smooths away the path tracer's leftover noise but keeps
// edges and detail. It follows the spatial half of SVGF, "spatiotemporal
// variance-guided filtering" (Schied et al., 2017), which is built for a
// still image like ours; the temporal half, for a moving camera, comes later.
// https://research.nvidia.com/publication/2017-07_spatiotemporal-variance-guided-filtering-real-time-reconstruction-path-traced
//
// It runs after the tracer, on the per-pixel records the tracer keeps
// (PixelRecord), in three steps (denoise-pass.ts):
// 1. prepare: per pixel, the light arriving at the surface with the
//    surface's own color divided out ("illumination"), and how noisy that
//    still is (its variance).
// 2. atrous, run 1 to 10 times: each pixel becomes a weighted average of a
//    5×5 grid of pixels around it, spaced 1, 2, 4, 8 … pixels apart,
//    doubling each time. Neighbors on a different surface, or brighter or darker than the
//    noise explains, get little or no weight, so edges stay sharp.
// 3. show: multiply the surface color back in, then tone map, as the tracer
//    does for the plain image.

// ---- Shared with tracer.wgsl ---------------------------------------------
// Copies; denoise.test.ts checks they still match.

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
  // The camera the last frame was drawn with, to find where each point was
  // on screen then (its motion vector). The same as above while it's still.
  previousCameraPos: vec3f,
  previousCameraRight: vec3f,
  previousCameraUp: vec3f,
  previousCameraForward: vec3f,
}

struct PixelRecord {
  light: vec4f, // the rest: rgb, running total of light (or a debug view's value); a, of luminance(light)²
  albedo: vec4f, // the rest: rgb, running total of the first surface's color (firstColor); a, 1 once surface is set
  surface: vec4f, // firstSurface from the first sample that hit a surface (usually sample 0, through the center)
  noiseFree: vec4f, // the noise-free samples: rgb, running total of their screen colors (toneMap); a, how many
}

const NO_HIT = 1e30;

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn toneMap(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn encodeSrgb(linear: vec3f) -> vec3f {
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

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
// ---- Inputs and outputs --------------------------------------------------
// Each step uses only some of these; 'auto' layout gives each pipeline the
// ones its entry point uses (denoise-pass.ts).

@group(0) @binding(0) var<uniform> frame: Frame; // the tracer's, from the last sample drawn
@group(0) @binding(1) var<storage, read> pixels: array<PixelRecord>;
// Illumination, one vec4f per pixel: rgb, and its variance in a, or -1 where
// there's nothing to denoise (sky and glowing surfaces). Two buffers take
// turns: each step reads one and writes the other ("ping-pong"), since a
// pixel's new value needs its neighbors' old ones.
@group(0) @binding(2) var<storage, read> illuminationIn: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> illuminationOut: array<vec4f>;
@group(0) @binding(4) var<uniform> spacing: u32; // atrous: pixels between grid points, 1 to 512
// What neighbors are compared by (Guide), packed into 16 bytes per pixel:
// prepare writes it once, and every pass reads it 25 times per pixel.
@group(0) @binding(5) var<storage, read_write> guideOut: array<vec4u>;
@group(0) @binding(6) var<storage, read> guides: array<vec4u>;

// ---- Helpers -------------------------------------------------------------
// The filter passes do the same sums for 25 neighbors of every pixel, so
// these are arranged to keep that work small. Integrated GPUs, especially on
// battery, run out of arithmetic before memory here, and exp, division and
// square roots cost several times a multiply. Written plainly, with 9 of
// those per neighbor, 2 passes took 33 to 46 ms at 1280×800 on an Iris Xe on
// battery; with the 2 that are left, 11 to 23 (checked on 2026-11-10).

fn slotOf(pixel: vec2u) -> u32 {
  return pixel.y * u32(frame.resolution.x) + pixel.x;
}

// The number of samples in each pixel's running totals.
fn sampleCount() -> f32 {
  return f32(frame.sampleIndex + 1u);
}

// How many of them hit a surface, which is what the light and albedo totals
// hold. The others went straight to a light or the sky, so have no noise to
// remove; they're in record.noiseFree (see tracer.wgsl's screenColor).
fn restCount(record: PixelRecord) -> f32 {
  return sampleCount() - record.noiseFree.a;
}

// Below this, a color counts as this dark. Dividing by a color near zero would
// blow tiny noise up into huge numbers; multiplying by the same floor at the
// end undoes it exactly, so the floor only limits how far noise can spread.
const ALBEDO_FLOOR = 0.01;

// The average color of what the pixel shows. Averaged over all samples, so a
// pixel half on a black square and half on a white one gets gray, and
// multiplying it back in keeps texture edges as smooth as without denoising.
fn albedoOf(record: PixelRecord) -> vec3f {
  return max(record.albedo.rgb / max(restCount(record), 1.0), vec3f(ALBEDO_FLOOR));
}

// A pixel center's position on the imaginary screen one unit in front of the
// camera, -1..1 on both axes with +y up, as in tracer.wgsl's fs().
fn screenPoint(pixel: vec2u) -> vec2f {
  let center = vec2f(pixel) + 0.5;
  return vec2f(center.x / frame.resolution.x * 2.0 - 1.0, 1.0 - center.y / frame.resolution.y * 2.0);
}

// The direction through a screen point, not normalized: its length along
// cameraForward is exactly 1. So a point at "depth" z along cameraForward is
// cameraPos + rayThrough(ndc) * z, with no square root.
fn rayThrough(ndc: vec2f) -> vec3f {
  return frame.cameraForward
    + frame.cameraRight * (ndc.x * frame.tanHalfFovY * frame.aspect)
    + frame.cameraUp * (ndc.y * frame.tanHalfFovY);
}

// What the filter compares a pixel's neighbors by.
struct Guide {
  normal: vec3f,
  depth: f32, // along cameraForward; NO_HIT where there's nothing to denoise
  logAlbedo: vec3f, // log2 of the color, so ratios become differences
}

fn guideOf(pixel: vec2u, record: PixelRecord) -> Guide {
  var depth = NO_HIT;
  if (record.surface.w < NO_HIT) {
    // The record keeps the distance along the ray; the ray's length per unit
    // of depth turns it into depth.
    depth = record.surface.w / length(rayThrough(screenPoint(pixel)));
  }
  return Guide(record.surface.xyz, depth, log2(albedoOf(record)));
}

// Packed into 16 bytes, which halves what the passes read. The depth stays a
// full 32-bit float, for the plane test; the normal gets 8 bits per axis
// (within about 0.3°), and the color 16-bit floats.
// https://www.w3.org/TR/WGSL/#pack-builtin-functions
fn packGuide(g: Guide) -> vec4u {
  return vec4u(
    bitcast<u32>(g.depth),
    pack4x8snorm(vec4f(g.normal, 0.0)),
    pack2x16float(g.logAlbedo.rg),
    pack2x16float(vec2f(g.logAlbedo.b, 0.0)),
  );
}

fn guideAt(slot: u32) -> Guide {
  let packed = guides[slot];
  // Rounding to 8 bits leaves the normal a little off unit length, which the
  // normal test below would read as a turn of several degrees.
  let normal = normalize(unpack4x8snorm(packed.y).xyz);
  let logAlbedo = vec3f(unpack2x16float(packed.z), unpack2x16float(packed.w).x);
  return Guide(normal, bitcast<f32>(packed.x), logAlbedo);
}

// How much a neighbor `reach` pixels away looks like the same surface. Three
// tests, the first two from SVGF:
// - Normals: on another surface, or round a curve, the neighbor faces a
//   different way. The weight is cos(angle)^128: 0.88 at 3°, 0.14 at 8°, 0 at
//   20°.
// - Planes: a neighbor on the same flat surface lies in the plane through
//   this pixel's hit point, even at a grazing angle where its distance from
//   the camera is very different. One in front or behind sits off that plane
//   by more than about a pixel's width for each pixel of reach.
// - Colors: dividing out the color (prepare) assumes all the light a surface
//   sends back is in proportion to its color. Some isn't: the glint off its
//   top layer, which is white whatever the color under it, and haze in front
//   of it. Divided by a dark color, those come out far brighter than next
//   to a light one, so a black checker square would take in its white
//   neighbors' much smaller values and come out too dark. Neighbors whose
//   colors differ by 20% count about a third.
const PLANE_TOLERANCE = 1.0; // pixel widths off the plane, per pixel of reach
const COLOR_TOLERANCE = 0.263; // log2(1.2): a 20% difference in any of red, green, blue

// Everything about the center pixel that the tests need, worked out once.
struct Center {
  normal: vec3f,
  // A neighbor at screen point ndc and depth z sits off this pixel's plane by
  // |(plane.x + plane.y·ndc.x + plane.z·ndc.y)·z - plane.w|: the dot product
  // of the normal with (cameraPos + rayThrough(ndc)·z - this point), with the
  // parts that don't depend on the neighbor multiplied out in advance.
  plane: vec4f,
  inversePixelWidth: f32, // 1 / (PLANE_TOLERANCE × the width one pixel covers here)
  logAlbedo: vec3f,
}

fn centerOf(pixel: vec2u, g: Guide) -> Center {
  let ray = rayThrough(screenPoint(pixel));
  let n = g.normal;
  let plane = vec4f(
    dot(n, frame.cameraForward),
    dot(n, frame.cameraRight) * frame.tanHalfFovY * frame.aspect,
    dot(n, frame.cameraUp) * frame.tanHalfFovY,
    dot(n, ray) * g.depth,
  );
  // Each pixel spans the same angle: the screen's height covers 2·tan(fov/2).
  let pixelWidth = g.depth * length(ray) * 2.0 * frame.tanHalfFovY / frame.resolution.y;
  return Center(n, plane, 1.0 / (PLANE_TOLERANCE * pixelWidth), g.logAlbedo);
}

// The surface tests' share of a neighbor's weight, as the normal factor and
// the exponent for exp(-…): the caller adds its own term and takes one exp.
struct Likeness {
  facing: f32,
  difference: f32,
}

fn likeness(c: Center, other: Guide, pixel: vec2u, inverseReach: f32) -> Likeness {
  // x^128 by squaring seven times. pow(x, 128.0) would be the same, except
  // WGSL defines it through log2(x), which has no value at x = 0.
  // https://www.w3.org/TR/WGSL/#floating-point-accuracy
  var facing = max(dot(c.normal, other.normal), 0.0);
  for (var i = 0; i < 7; i++) {
    facing *= facing;
  }
  let ndc = screenPoint(pixel);
  let offPlane = abs((c.plane.x + c.plane.y * ndc.x + c.plane.z * ndc.y) * other.depth - c.plane.w);
  let colors = abs(other.logAlbedo - c.logAlbedo);
  let colorDifference = max(colors.r, max(colors.g, colors.b));
  return Likeness(facing, offPlane * c.inversePixelWidth * inverseReach + colorDifference * (1.0 / COLOR_TOLERANCE));
}

// ---- 1. Prepare ----------------------------------------------------------
// One thread per pixel, in tiles of 8×8. Must match DENOISE_WORKGROUP_SIZE
// in gpu-layout.ts.

// With fewer samples than this, a pixel's own samples say too little about
// how noisy it is, so its neighbors' spread is used instead.
const MIN_SAMPLES_FOR_VARIANCE = 4u;

@compute @workgroup_size(8, 8)
fn prepare(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(frame.resolution);
  let slot = slotOf(id.xy);
  if (any(id.xy >= size) || slot >= arrayLength(&pixels)) {
    return;
  }
  let record = pixels[slot];
  let g = guideOf(id.xy, record);
  guideOut[slot] = packGuide(g);
  let n = restCount(record);
  let mean = record.light.rgb / max(n, 1.0);
  if (g.depth >= NO_HIT) {
    illuminationOut[slot] = vec4f(mean, -1.0); // sky or a glowing surface: shown as it is
    return;
  }
  // "Demodulation": the light reaching the surface, without the surface's
  // color. A checkerboard or tiled wall then becomes one smooth field of
  // light to average, and its pattern can't smear.
  let albedo = albedoOf(record);
  var variance: f32;
  if (n >= f32(MIN_SAMPLES_FOR_VARIANCE)) {
    // Variance of a sample = mean of squares - square of mean. The average
    // of n samples varies n times less, which is what the screen shows; so
    // the filter does less as the image refines. (n - 1, not n: Bessel's
    // correction, since the mean came from the same samples.)
    let brightness = luminance(mean);
    let spread = max(record.light.a / n - brightness * brightness, 0.0) * n / (n - 1.0);
    let brightnessOfColor = luminance(albedo);
    variance = spread / n / (brightnessOfColor * brightnessOfColor);
  } else {
    variance = neighborVariance(id.xy, size, g);
  }
  illuminationOut[slot] = vec4f(mean / albedo, variance);
}

// How much the illumination differs between this pixel and its 3×3
// neighbors on the same surface. Real detail counts as noise here too, so
// it overestimates, which only matters for the first few samples. (It reads
// the records, since the packed guides are being written at the same time.)
fn neighborVariance(pixel: vec2u, size: vec2u, g: Guide) -> f32 {
  let c = centerOf(pixel, g);
  var weights = 0.0;
  var sum = 0.0;
  var sumOfSquares = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = vec2i(pixel) + vec2i(dx, dy);
      if (any(q < vec2i(0)) || any(q >= vec2i(size))) {
        continue;
      }
      let neighbor = vec2u(q);
      let record = pixels[slotOf(neighbor)];
      if (record.surface.w >= NO_HIT) {
        continue;
      }
      var w = 1.0;
      if (dx != 0 || dy != 0) {
        let like = likeness(c, guideOf(neighbor, record), neighbor, inverseSqrt(f32(dx * dx + dy * dy)));
        w = like.facing * exp(-like.difference);
      }
      let l = luminance(record.light.rgb / restCount(record) / albedoOf(record));
      weights += w;
      sum += w * l;
      sumOfSquares += w * l * l;
    }
  }
  let mean = sum / weights;
  return max(sumOfSquares / weights - mean * mean, 0.0);
}

// ---- 2. À-trous filter ---------------------------------------------------
// "À trous" is French for "with holes": the same 5×5 grid is spread wider
// each time, with gaps between its points. Five passes reach 62 pixels from
// the center, for the cost of 125 reads instead of the 15,625 of one wide
// grid. Each pass smooths what the last left: the near passes remove fine
// grain, the far ones the blotches the near ones leave.
// Dammertz et al., "Edge-Avoiding À-Trous Wavelet Transform for fast Global
// Illumination Filtering", 2010: https://jo.dreggn.org/home/2010_atrous.pdf

// How far a neighbor's brightness may differ before it stops counting, in
// standard deviations of the noise: SVGF's value. A difference the noise
// can't explain is detail, such as a shadow's edge.
const LUMINANCE_TOLERANCE = 4.0;

// The B3 spline kernel along one axis, by distance from the center: weights
// 1/16, 1/4, 3/8, 1/4, 1/16. A smooth bell, so the result has no blocky
// look; the 2D weight is the product of the x and y weights.
fn kernel(offset: i32) -> f32 {
  switch abs(offset) {
    case 0: {
      return 3.0 / 8.0;
    }
    case 1: {
      return 1.0 / 4.0;
    }
    default: {
      return 1.0 / 16.0;
    }
  }
}

// The variance, averaged over the 3×3 pixels around: one pixel's variance
// is itself noisy, and the filter would jump with it. Weights 1/4, 1/2, 1/4.
fn smoothedVariance(pixel: vec2u, size: vec2u) -> f32 {
  var weights = 0.0;
  var sum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = vec2i(pixel) + vec2i(dx, dy);
      if (any(q < vec2i(0)) || any(q >= vec2i(size))) {
        continue;
      }
      let variance = illuminationIn[slotOf(vec2u(q))].a;
      if (variance < 0.0) {
        continue; // nothing to denoise there
      }
      let w = (2.0 - f32(abs(dx))) * (2.0 - f32(abs(dy)));
      weights += w;
      sum += w * variance;
    }
  }
  return sum / weights;
}

@compute @workgroup_size(8, 8)
fn atrous(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(frame.resolution);
  let slot = slotOf(id.xy);
  if (any(id.xy >= size) || slot >= arrayLength(&guides)) {
    return;
  }
  let middle = illuminationIn[slot];
  if (middle.a < 0.0) {
    illuminationOut[slot] = middle; // sky or a glowing surface
    return;
  }
  let c = centerOf(id.xy, guideAt(slot));
  let brightness = luminance(middle.rgb);
  // 1 / (tolerance × the noise's standard deviation). The tiny constant
  // avoids dividing by zero once the noise is all gone; then only neighbors
  // exactly as bright count.
  let inverseNoise = 1.0 / (LUMINANCE_TOLERANCE * sqrt(smoothedVariance(id.xy, size)) + 1e-10);
  let inverseSpacing = 1.0 / f32(spacing);

  var weights = 0.0;
  var sum = vec3f(0.0);
  var variance = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let q = vec2i(id.xy) + vec2i(dx, dy) * i32(spacing);
      if (any(q < vec2i(0)) || any(q >= vec2i(size))) {
        continue;
      }
      let neighborSlot = slotOf(vec2u(q));
      let neighbor = illuminationIn[neighborSlot];
      if (neighbor.a < 0.0) {
        continue; // nothing to denoise there, so not part of this surface
      }
      var w = kernel(dx) * kernel(dy);
      if (dx != 0 || dy != 0) {
        let inverseReach = inverseSqrt(f32(dx * dx + dy * dy)) * inverseSpacing;
        let like = likeness(c, guideAt(neighborSlot), vec2u(q), inverseReach);
        // One exp for all three tests: e^-a · e^-b = e^-(a+b).
        w *= like.facing * exp(-(like.difference + abs(luminance(neighbor.rgb) - brightness) * inverseNoise));
      }
      weights += w;
      sum += w * neighbor.rgb;
      // An average of independent values with weights w has variance
      // Σw²·variance / (Σw)², so the next pass knows how much noise is left.
      variance += w * w * neighbor.a;
    }
  }
  illuminationOut[slot] = vec4f(sum / weights, variance / (weights * weights));
}

// ---- 3. Show -------------------------------------------------------------
// A full-screen triangle, as in tracer.wgsl.

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

// The denoised image: the filtered illumination times the surface color,
// blended with the noise-free samples as the tracer does.
@fragment
fn showDenoised(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let slot = slotOf(vec2u(pixel.xy));
  if (slot >= arrayLength(&pixels)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let record = pixels[slot];
  var restMean = record.light.rgb / max(restCount(record), 1.0);
  if (record.surface.w < NO_HIT) {
    restMean = illuminationIn[slot].rgb * albedoOf(record);
  }
  return vec4f(screenColor(restMean, record.noiseFree, sampleCount()), 1.0);
}

// The plain average, as the tracer shows it: for turning the slider back to
// 0 on a finished image, without tracing another sample.
@fragment
fn showRaw(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let slot = slotOf(vec2u(pixel.xy));
  if (slot >= arrayLength(&pixels)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let record = pixels[slot];
  return vec4f(screenColor(record.light.rgb / max(restCount(record), 1.0), record.noiseFree, sampleCount()), 1.0);
}
