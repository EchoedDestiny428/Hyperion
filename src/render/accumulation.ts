import type { Scene } from '../scene/scene.ts';
import type { FrameParams } from './frame-uniforms.ts';

// Progressive accumulation. While nothing changes, frames add samples to a
// running total per pixel on the GPU, and the screen shows the average, so
// the image keeps getting smoother. Anything that changes what the image
// shows (canvas size, sun, renderer, view, scene, sliders) starts the total
// over. Moving the camera doesn't: each pixel carries on from where its point
// was last frame (reprojection, in tracer.wgsl), so only what just came into
// view starts over.

// The sample-count choices in the Anti-aliasing menu, like games' "4x" or
// "16x" supersampling. The image stops refining at the chosen count, and
// stopping lets the GPU rest (the canvas keeps showing the last image).
export const SAMPLE_LIMITS = [1, 4, 16, 64, 256, 1024] as const;
export const MAX_SAMPLES = 1024;

// How fast samples are added: one per frame, a few per second to watch the
// image build up, or one each time you press "Next sample".
export type Pace = 'full' | 'slow' | 'step';
export const SLOW_PACE_MS = 250; // 4 samples per second

// Everything the image depends on, apart from which sample this is. The
// last frame's camera isn't part of the picture, only of how it got there.
export type ImageInputs = Omit<FrameParams, 'sampleIndex' | 'previousCamera' | 'cameraMoved'>;

export interface SampleCounter {
  // Samples since the picture last started over. Moving the camera doesn't
  // start it over. The shader seeds its random numbers with this, so every
  // frame, moving or not, gets new ones.
  readonly held: number;
  // Samples since anything changed, the camera included: what the Samples
  // limit and pace count, so a picture always refines again after a move.
  readonly still: number;
  readonly moved: boolean; // the camera moved since the frame before (set by check())
  // Starts the picture over if what it shows has changed since last frame,
  // and notes whether the camera moved.
  check(inputs: ImageInputs, scene: Scene): void;
  // Claims the next sample and returns its index, `held` before counting it
  // (0 = the shader starts over instead of adding to the history).
  take(): number;
  restart(): void;
}

export function createSampleCounter(): SampleCounter {
  let previousKey = '';
  let previousCamera = '';
  let previousScene: Scene | null = null;
  let held = 0;
  let still = 0;
  let moved = false;
  return {
    get held() {
      return held;
    },
    get still() {
      return still;
    },
    get moved() {
      return moved;
    },
    check(inputs, scene) {
      // Comparing the JSON text compares every field, including any added
      // to FrameParams later. It's a few hundred characters per frame.
      const { camera, ...picture } = inputs;
      const key = JSON.stringify(picture);
      const cameraKey = JSON.stringify(camera);
      if (key !== previousKey || scene !== previousScene) {
        previousKey = key;
        previousScene = scene;
        held = 0;
        still = 0;
      }
      moved = previousCamera !== '' && cameraKey !== previousCamera;
      previousCamera = cameraKey;
      if (moved) still = 0;
    },
    take() {
      still++;
      return held++;
    },
    restart() {
      held = 0;
      still = 0;
    },
  };
}

export interface PaceState {
  held: number; // samples in the running total now
  limit: number; // stop at this many
  pace: Pace;
  msSinceLastSample: number;
  stepRequested: boolean; // "Next sample" was pressed
}

// How many samples the image should hold at the end of this frame. It's
// never more than one above `held`, since a frame adds at most one sample.
export function targetSamples(s: PaceState): number {
  // Right after a change there's nothing to show, so the first sample is
  // always drawn straight away, whatever the pace.
  if (s.held === 0) return 1;
  const addOne =
    s.pace === 'full' ||
    (s.pace === 'slow' && s.msSinceLastSample >= SLOW_PACE_MS) ||
    (s.pace === 'step' && s.stepRequested);
  return Math.min(addOne ? s.held + 1 : s.held, s.limit);
}
