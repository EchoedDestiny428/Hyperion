// Keeps the canvas's drawing buffer (canvas.width/height, in real device
// pixels) the same size as the canvas on screen. Then one rendered pixel is
// exactly one screen pixel: sharp, and no work wasted on pixels nobody sees.

// We request a device with default limits, where maxTextureDimension2D is
// 8192, and the canvas texture can't be bigger than that.
// https://www.w3.org/TR/webgpu/#limits
const MAX_CANVAS_DIMENSION = 8192;

export function trackCanvasSize(canvas: HTMLCanvasElement): () => void {
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      // Exact device-pixel size where the browser provides it (Chrome 84+,
      // Firefox 108+; Safari doesn't, as of 2026-10). Otherwise estimate it
      // from CSS pixels × devicePixelRatio, which can be off by a pixel.
      // https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserverEntry/devicePixelContentBoxSize
      const exact = entry.devicePixelContentBoxSize?.[0];
      const css = entry.contentBoxSize[0];
      const width = exact ? exact.inlineSize : Math.round((css?.inlineSize ?? 1) * devicePixelRatio);
      const height = exact ? exact.blockSize : Math.round((css?.blockSize ?? 1) * devicePixelRatio);
      canvas.width = clamp(width, 1, MAX_CANVAS_DIMENSION);
      canvas.height = clamp(height, 1, MAX_CANVAS_DIMENSION);
    }
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas, { box: 'content-box' });
  }
  return () => observer.disconnect();
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
