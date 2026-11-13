// What the Renderer panel switches: which renderer draws the image, and which
// debug view (if any) replaces it. The shader reads both as numbers from
// struct Frame. Must match the RENDERER_* and VIEW_* constants in
// tracer.wgsl; settings.test.ts checks.

import { MAX_SAMPLES, type Pace } from './accumulation.ts';

export const RENDERERS = {
  whitted: 0, // C0: one ray per pixel, fake ambient light
  path: 1, // C1: light really bounces
} as const;

export type Renderer = keyof typeof RENDERERS;
export const RENDERER_NAMES = Object.keys(RENDERERS) as Renderer[];

// What the shader outputs instead of the final image. Except for "final",
// these show one ingredient of the image as false color.
export const VIEWS = {
  final: 0, // the lit image
  color: 1, // each surface's color with no lighting (albedo)
  normals: 2, // which way each surface faces
  distance: 3, // how far the ray travelled
  sunlight: 4, // lit, cast shadow, or facing away from the sun
  rays: 5, // how many rays the pixel cost
  motion: 6, // how far and which way each point moved on screen since the last frame
  history: 7, // how many samples each pixel holds, which differs once the camera has moved
  discarded: 8, // where history was thrown away this frame, and why
} as const;

export type View = keyof typeof VIEWS;
export const VIEW_NAMES = Object.keys(VIEWS) as View[];

export type CameraMode = 'orbit' | 'fly';

// What the Renderer panel edits and the frame loop reads.
export interface RenderSettings {
  renderer: Renderer;
  cameraMode: CameraMode;
  view: View;
  sunMoves: boolean; // on = the sun circles, so the image can't refine
  sampleLimit: number; // anti-aliasing: one of SAMPLE_LIMITS
  pace: Pace;
  denoise: number; // filter passes, 0 (off) to MAX_DENOISE_LEVEL
  bounces: number; // path tracer: the most surfaces one path visits, 1 to MAX_BOUNCES
  exposure: number; // in stops, MIN_EXPOSURE to MAX_EXPOSURE; each scene sets its own
  history: number; // while moving, how many samples a pixel carries over, 0 to MAX_HISTORY
}

export function defaultSettings(): RenderSettings {
  // The sun starts still: a moving sun changes the image every frame, which
  // restarts accumulation every frame.
  return {
    renderer: 'path',
    cameraMode: 'orbit',
    view: 'final',
    sunMoves: false,
    sampleLimit: MAX_SAMPLES,
    pace: 'full',
    // Measured on 2026-11-10 (docs/learn/C2.md, section 8): 2 passes made
    // every scene cleaner at 4, 16 and 64 samples, and smears the least.
    denoise: 2,
    bounces: DEFAULT_BOUNCES,
    exposure: 0,
    history: DEFAULT_HISTORY,
  };
}

// The History slider: while the camera moves, each pixel carries over at
// most this many samples from earlier frames, on top of its 1 new one. 4 had
// the least error with the denoiser on, against 8, 16 and 32 (npm run
// motion on motion-test, checked on 2026-11-11).
export const DEFAULT_HISTORY = 4;
export const MAX_HISTORY = 64;

// The history a moving pixel may keep: the History slider, but never more
// than the Samples menu allows in all, so "1 (none)" really means one.
export function historyCap(s: RenderSettings): number {
  return Math.max(0, Math.min(s.history, s.sampleLimit - 1));
}

// The Exposure slider, in photographers' "stops": each one doubles (or
// halves) the light reaching the picture, before tone mapping. Changing it
// starts the samples over, because lights and sky seen directly are tone
// mapped one sample at a time (isNoiseFree in tracer.wgsl).
export const MIN_EXPOSURE = -3;
export const MAX_EXPOSURE = 3;
export const EXPOSURE_STEP = 0.5;

export function exposureText(stops: number): string {
  if (stops === 0) return '0 stops';
  return `${stops > 0 ? '+' : '−'}${Math.abs(stops)} ${Math.abs(stops) === 1 ? 'stop' : 'stops'}`;
}

// The Bounces slider (tracePath in tracer.wgsl). 8 was C1's fixed limit: on
// the Cornell box, going to 64 changed the result by under 0.5%.
export const DEFAULT_BOUNCES = 8;
export const MAX_BOUNCES = 64;

// How fast the sun circles while "Sun moves" is ticked: sunDirection in
// tracer.wgsl turns it by frame.time × this (settings.test.ts checks).
export const SUN_RADIANS_PER_SECOND = 0.15;

// The Denoise slider: how many filter passes run (denoise.wgsl). Each pass
// spreads its 5×5 grid twice as wide as the last: 1, 2, 4 … 512 pixels.
// Past about 5, the grid's points land so far apart (often off the screen)
// that more passes change little; the slider goes to 10 to let you see that.
export const MAX_DENOISE_LEVEL = 10;

// The passes the image actually gets. Only the path tracer's lit image is
// denoised: the Whitted renderer has no noise to remove, and smoothing a
// debug view would hide what it's there to show.
//
// While the camera moves, one more pass than the slider says. A moving
// frame holds only a few samples per pixel, so it's limited by noise, which
// a wider filter removes; a still picture soon has little noise left, and
// there an extra pass mostly smears. On the dreamspace walk (npm run motion
// -- --scene dreamspace --walk 0.02), 3 passes had 8% less error than 2; on
// stills, 2 was best (checked on 2026-11-13).
export function denoiseLevel(s: RenderSettings, moving = false): number {
  if (s.renderer !== 'path' || s.view !== 'final' || s.denoise === 0) return 0;
  return moving ? Math.min(s.denoise + 1, MAX_DENOISE_LEVEL) : s.denoise;
}

// How far from a pixel, in pixels, `level` passes can gather light: each
// pass reaches 2 grid steps out, so 2·(1 + 2 + … + 2^(level-1)).
export function denoiseReach(level: number): number {
  return 2 * (2 ** level - 1);
}
