import type { Pace } from '../render/accumulation.ts';

// The heads-up display: which GPU we got, the canvas resolution, the average
// time between frames, and how many samples the image holds. Proper metrics
// (percentiles, GPU time) come later in C1.

export interface HudFrame {
  width: number;
  height: number;
  samples: number; // in each pixel's average this frame
  sampleLimit: number;
  pace: Pace;
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
      'Hyperion · C1 in progress · Whitted ray tracer',
      `GPU     ${gpuLabel}`,
      `Canvas  ${info.width}×${info.height}`,
      `Frame   ${frameText}`,
      `Samples ${info.samples} / ${info.sampleLimit} (${sampleStatus(info)})`,
      'Drag to orbit · scroll to zoom',
    ].join('\n');
  };
  render({ width: 0, height: 0, samples: 0, sampleLimit: 1, pace: 'full' }, 'measuring…');
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
      // display's refresh rate. It is not how long the GPU took (C1 adds that).
      render(info, `${average.toFixed(2)} ms (${(1000 / average).toFixed(0)} fps, capped by refresh rate)`);
    },
  };
}

function sampleStatus(info: HudFrame): string {
  if (info.samples >= info.sampleLimit) return 'done';
  if (info.pace === 'step') return 'press Next sample';
  return info.samples <= 1 ? 'hold still to refine' : 'refining';
}
