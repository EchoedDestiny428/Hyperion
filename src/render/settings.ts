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
  };
}

// The Bounces slider (tracePath in tracer.wgsl). 8 was C1's fixed limit: on
// the Cornell box, going to 64 changed the result by under 0.5%.
export const DEFAULT_BOUNCES = 8;
export const MAX_BOUNCES = 64;

// The Denoise slider: how many filter passes run (denoise.wgsl). Each pass
// spreads its 5×5 grid twice as wide as the last: 1, 2, 4 … 512 pixels.
// Past about 5, the grid's points land so far apart (often off the screen)
// that more passes change little; the slider goes to 10 to let you see that.
export const MAX_DENOISE_LEVEL = 10;

// The passes the image actually gets. Only the path tracer's lit image is
// denoised: the Whitted renderer has no noise to remove, and smoothing a
// debug view would hide what it's there to show.
export function denoiseLevel(s: RenderSettings): number {
  return s.renderer === 'path' && s.view === 'final' ? s.denoise : 0;
}

// How far from a pixel, in pixels, `level` passes can gather light: each
// pass reaches 2 grid steps out, so 2·(1 + 2 + … + 2^(level-1)).
export function denoiseReach(level: number): number {
  return 2 * (2 ** level - 1);
}
