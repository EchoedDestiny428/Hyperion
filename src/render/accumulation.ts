import type { Scene } from '../scene/scene.ts';
import type { FrameParams } from './frame-uniforms.ts';

// Progressive accumulation. While nothing changes, frames add samples to a
// running total per pixel on the GPU, and the screen shows the average, so
// the image keeps getting smoother. Anything that changes what the image
// shows (camera, canvas size, sun, renderer, view, scene) starts the total over.

// The sample-count choices in the Anti-aliasing menu, like games' "4x" or
// "16x" supersampling. The image stops refining at the chosen count, and
// stopping lets the GPU rest (the canvas keeps showing the last image).
export const SAMPLE_LIMITS = [1, 4, 16, 64, 256, 1024] as const;
export const MAX_SAMPLES = 1024;

// How fast samples are added: one per frame, a few per second to watch the
// image build up, or one each time you press "Next sample".
export type Pace = 'full' | 'slow' | 'step';
export const SLOW_PACE_MS = 250; // 4 samples per second

// Everything the image depends on, apart from which sample this is.
export type ImageInputs = Omit<FrameParams, 'sampleIndex'>;

export interface SampleCounter {
  readonly held: number; // samples in the running total
  // Forgets the total if what the image shows has changed since last frame.
  check(inputs: ImageInputs, scene: Scene): void;
  // Claims the next sample and returns its index, which is how many samples
  // the total already holds (0 = the shader overwrites instead of adding).
  take(): number;
  restart(): void;
}

export function createSampleCounter(): SampleCounter {
  let previousKey = '';
  let previousScene: Scene | null = null;
  let held = 0;
  return {
    get held() {
      return held;
    },
    check(inputs, scene) {
      // Comparing the JSON text compares every field, including any added
      // to FrameParams later. It's a few hundred characters per frame.
      const key = JSON.stringify(inputs);
      if (key !== previousKey || scene !== previousScene) {
        previousKey = key;
        previousScene = scene;
        held = 0;
      }
    },
    take() {
      return held++;
    },
    restart() {
      held = 0;
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
