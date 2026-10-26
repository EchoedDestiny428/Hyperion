import type { CameraBasis } from '../camera/orbit.ts';

// The per-frame values the shader reads, packed exactly like `struct Frame`
// in whitted.wgsl. WGSL aligns a vec3f to 16 bytes, so each vec3f leaves 4
// spare bytes, and we put a single f32 there instead of wasting them.
// https://www.w3.org/TR/WGSL/#alignment-and-size
//
//   float index:  0..2 cameraPos      3 tanHalfFovY
//                 4..6 cameraRight    7 aspect
//                 8..10 cameraUp     11 time
//                12..14 cameraForward 15 (padding)
//                16..17 resolution   18..19 (padding: struct size rounds up to 16 bytes)
export const FRAME_UNIFORM_FLOATS = 20; // = 80 bytes

export interface FrameParams {
  camera: CameraBasis;
  verticalFovRadians: number;
  width: number; // canvas size in device pixels
  height: number;
  timeSeconds: number;
}

export function packFrameUniforms(
  p: FrameParams,
  out: Float32Array = new Float32Array(FRAME_UNIFORM_FLOATS),
): Float32Array {
  out.set(p.camera.position, 0);
  out[3] = Math.tan(p.verticalFovRadians / 2);
  out.set(p.camera.right, 4);
  out[7] = p.width / p.height;
  out.set(p.camera.up, 8);
  out[11] = p.timeSeconds;
  out.set(p.camera.forward, 12);
  out[15] = 0;
  out[16] = p.width;
  out[17] = p.height;
  out[18] = 0;
  out[19] = 0;
  return out;
}
