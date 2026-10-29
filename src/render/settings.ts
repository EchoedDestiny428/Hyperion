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
  };
}
