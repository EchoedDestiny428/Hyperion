import type { CameraBasis } from '../camera/orbit.ts';

// The per-frame values the shader reads, packed exactly like `struct Frame`
// in tracer.wgsl. WGSL aligns a vec3f to 16 bytes, so each vec3f leaves 4
// spare bytes, and we put a single value there instead of wasting them.
// https://www.w3.org/TR/WGSL/#alignment-and-size
//
//   slot (4 bytes each):  0..2 cameraPos      3 tanHalfFovY
//                         4..6 cameraRight    7 aspect
//                         8..10 cameraUp     11 time
//                        12..14 cameraForward 15 renderer (u32)
//                        16..17 resolution   18 view (u32)   19 sampleIndex (u32)
//                        20 maxBounces (u32)  21 exposure  22 cameraMoved (u32)  23 padding
//                        24..26 previousCameraPos      27 padding
//                        28..30 previousCameraRight    31 padding
//                        32..34 previousCameraUp       35 padding
//                        36..38 previousCameraForward  39 padding
// A vec3f starts on a 16-byte boundary, and a uniform struct's size rounds up
// to a multiple of 16 bytes, hence the padding.
export const FRAME_UNIFORM_FLOATS = 40; // = 160 bytes

export interface FrameParams {
  camera: CameraBasis;
  verticalFovRadians: number;
  width: number; // canvas size in device pixels
  height: number;
  timeSeconds: number; // drives the sun's movement
  renderer: number; // a value of RENDERERS in settings.ts
  view: number; // a value of VIEWS in settings.ts
  sampleIndex: number; // samples already in the running total; 0 = start over (accumulation.ts)
  maxBounces: number; // path tracer: the most surfaces one path visits
  exposure: number; // in stops: each one doubles the light before tone mapping
  previousCamera: CameraBasis; // the last frame's camera; `camera` again on the first frame
  cameraMoved: boolean; // camera isn't previousCamera, so pixels look up their history where their point was
}

export function packFrameUniforms(
  p: FrameParams,
  out: Float32Array = new Float32Array(FRAME_UNIFORM_FLOATS),
): Float32Array {
  // `renderer`, `view` and `sampleIndex` are u32 in the shader. Written through
  // the float view they'd become float bit patterns, so they go through an
  // integer view of the same bytes.
  const ints = new Uint32Array(out.buffer, out.byteOffset, FRAME_UNIFORM_FLOATS);
  out.set(p.camera.position, 0);
  out[3] = Math.tan(p.verticalFovRadians / 2);
  out.set(p.camera.right, 4);
  out[7] = p.width / p.height;
  out.set(p.camera.up, 8);
  out[11] = p.timeSeconds;
  out.set(p.camera.forward, 12);
  ints[15] = p.renderer;
  out[16] = p.width;
  out[17] = p.height;
  ints[18] = p.view;
  ints[19] = p.sampleIndex;
  ints[20] = p.maxBounces;
  // The shader wants the multiplier. 2^0 is exactly 1, so at 0 stops the
  // picture is exactly what it was without exposure.
  out[21] = 2 ** p.exposure;
  ints[22] = p.cameraMoved ? 1 : 0;
  out.set(p.previousCamera.position, 24);
  out.set(p.previousCamera.right, 28);
  out.set(p.previousCamera.up, 32);
  out.set(p.previousCamera.forward, 36);
  return out;
}
