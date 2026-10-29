import type { CameraBasis } from '../camera/orbit.ts';

// The per-frame values the shader reads, packed exactly like `struct Frame`
// in whitted.wgsl. WGSL aligns a vec3f to 16 bytes, so each vec3f leaves 4
// spare bytes, and we put a single value there instead of wasting them.
// https://www.w3.org/TR/WGSL/#alignment-and-size
//
//   slot (4 bytes each):  0..2 cameraPos      3 tanHalfFovY
//                         4..6 cameraRight    7 aspect
//                         8..10 cameraUp     11 time
//                        12..14 cameraForward 15 layers (u32)
//                        16..17 resolution   18 view (u32)   19 sampleIndex (u32)
export const FRAME_UNIFORM_FLOATS = 20; // = 80 bytes

export interface FrameParams {
  camera: CameraBasis;
  verticalFovRadians: number;
  width: number; // canvas size in device pixels
  height: number;
  timeSeconds: number; // drives the sun's movement
  layers: number; // bit flags, from layerBits() in layers.ts
  view: number; // a value of VIEWS in layers.ts
  sampleIndex: number; // samples already in the running total; 0 = start over (accumulation.ts)
}

export function packFrameUniforms(
  p: FrameParams,
  out: Float32Array = new Float32Array(FRAME_UNIFORM_FLOATS),
): Float32Array {
  // `layers`, `view` and `sampleIndex` are u32 in the shader. Written through
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
  ints[15] = p.layers;
  out[16] = p.width;
  out[17] = p.height;
  ints[18] = p.view;
  ints[19] = p.sampleIndex;
  return out;
}
