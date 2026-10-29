import { percentile } from '../math/percentile.ts';
import type { Pace } from '../render/accumulation.ts';

// The heads-up display: which GPU we got, the canvas resolution, the time
// between frames, how long the GPU works per frame, and how many samples
// the image holds.

export interface HudFrame {
  renderer: string; // its name, as shown in the Renderer menu
  width: number;
  height: number;
  samples: number; // in each pixel's average this frame
  sampleLimit: number;
  pace: Pace;
  gpuTimes: readonly number[] | null; // recent GPU times in ms; null if they can't be measured
  camera: string; // which camera, e.g. "Orbit" or "Fly · 2.0 m/s"
}

export interface Hud {
  frame(now: number, info: HudFrame): void;
}

const INTERVAL_COUNT = 60; // frame intervals averaged
const TEXT_UPDATE_MS = 250;

export function createHud(element: HTMLElement, gpuLabel: string): Hud {
  const intervals: number[] = [];
  let previous = -1;
  let lastTextUpdate = -Infinity;

  const render = (info: HudFrame, frameText: string): void => {
    element.textContent = [
      `Hyperion · C1 in progress · ${info.renderer}`,
      `GPU      ${gpuLabel}`,
      `Canvas   ${info.width}×${info.height}`,
      `Frame    ${frameText}`,
      `GPU time ${gpuTimeText(info.gpuTimes)}`,
      `Samples  ${info.samples} / ${info.sampleLimit} (${sampleStatus(info)})`,
      `Camera   ${info.camera}`, // the key bindings are in the Camera menu's tooltip
    ].join('\n');
  };
  render(
    { renderer: '', width: 0, height: 0, samples: 0, sampleLimit: 1, pace: 'full', gpuTimes: [], camera: '' },
    'measuring…',
  );
  element.hidden = false;

  return {
    frame(now, info) {
      if (previous >= 0) {
        intervals.push(now - previous);
        if (intervals.length > INTERVAL_COUNT) intervals.shift();
      }
      previous = now;

      // Changing page text costs time, so only refresh it a few times per
      // second, which is all a person can read anyway. Except in step pace,
      // where each press of "Next sample" should show at once.
      const due = now - lastTextUpdate >= TEXT_UPDATE_MS || info.pace === 'step';
      if (!due || intervals.length === 0) return;
      lastTextUpdate = now;
      const average = intervals.reduce((sum, x) => sum + x, 0) / intervals.length;
      // This is the time *between* frames, which the browser caps at your
      // display's refresh rate. The GPU time line shows the work itself.
      render(info, `${average.toFixed(2)} ms (${(1000 / average).toFixed(0)} fps, capped by refresh rate)`);
    },
  };
}

// The typical frame (p50) and the slow ones (p95, p99), over recent frames.
function gpuTimeText(times: readonly number[] | null): string {
  if (times === null) return 'not measurable in this browser (no timestamp-query)';
  if (times.length === 0) return 'measuring…';
  const ms = (p: number): string => percentile(times, p).toFixed(2);
  return `p50 ${ms(50)} · p95 ${ms(95)} · p99 ${ms(99)} ms (last ${times.length} frames drawn)`;
}

function sampleStatus(info: HudFrame): string {
  if (info.samples >= info.sampleLimit) return 'done';
  if (info.pace === 'step') return 'press Next sample';
  return info.samples <= 1 ? 'hold still to refine' : 'refining';
}
