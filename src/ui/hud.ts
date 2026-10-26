// The heads-up display: which GPU we got, the canvas resolution, and the
// average time between frames. Proper metrics (percentiles, GPU time) come
// in C1.

export interface Hud {
  frame(now: number, width: number, height: number): void;
}

const SAMPLE_COUNT = 60;
const TEXT_UPDATE_MS = 250;

export function createHud(element: HTMLElement, gpuLabel: string): Hud {
  const intervals: number[] = [];
  let previous = -1;
  let lastTextUpdate = -Infinity;

  const render = (width: number, height: number, frameText: string): void => {
    element.textContent = [
      'Hyperion · C0 · Whitted ray tracer',
      `GPU     ${gpuLabel}`,
      `Canvas  ${width}×${height}`,
      `Frame   ${frameText}`,
      'Drag to orbit · scroll to zoom',
    ].join('\n');
  };
  render(0, 0, 'measuring…');
  element.hidden = false;

  return {
    frame(now, width, height) {
      if (previous >= 0) {
        intervals.push(now - previous);
        if (intervals.length > SAMPLE_COUNT) intervals.shift();
      }
      previous = now;

      // Changing page text costs time, so only refresh it a few times per
      // second, which is all a person can read anyway.
      if (now - lastTextUpdate < TEXT_UPDATE_MS || intervals.length === 0) return;
      lastTextUpdate = now;
      const average = intervals.reduce((sum, x) => sum + x, 0) / intervals.length;
      // This is the time *between* frames, which the browser caps at your
      // display's refresh rate. It is not how long the GPU took (C1 adds that).
      render(width, height, `${average.toFixed(2)} ms (${(1000 / average).toFixed(0)} fps, capped by refresh rate)`);
    },
  };
}
