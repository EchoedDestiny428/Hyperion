// Creating the GPU device, reporting its errors, and the rule for recovering
// when it's lost.

// The adapter is the physical GPU the browser offers; the device is our
// app's own connection to it. Every buffer, texture and pipeline we create
// belongs to the device.
export async function createDevice(adapter: GPUAdapter): Promise<GPUDevice> {
  // Default limits, except buffer sizes. The accumulation buffer holds 16
  // bytes per pixel, and the default 128 MB limit only covers about 8 million
  // pixels, a 4K canvas. Asking for whatever this GPU allows (often gigabytes)
  // lets bigger screens refine too. https://www.w3.org/TR/webgpu/#limits
  const device = await adapter.requestDevice({
    label: 'hyperion',
    // Optional: lets the HUD show real GPU time (gpu/timer.ts). Without it
    // everything else still works.
    requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  // WebGPU calls don't throw when you misuse them. Errors are reported
  // asynchronously, and any not caught by an error scope arrive here.
  // https://www.w3.org/TR/webgpu/#errors-and-debugging
  device.addEventListener('uncapturederror', (event) => {
    console.error('[WebGPU] uncaptured error:', event.error.message);
  });
  return device;
}

// A short human-readable name for the HUD, e.g. "nvidia · blackwell".
// adapter.info: https://developer.mozilla.org/en-US/docs/Web/API/GPUAdapter/info
export function describeAdapter(adapter: GPUAdapter): string {
  // Browsers may leave these fields empty to limit fingerprinting, so we
  // show whatever is there.
  const info = adapter.info as GPUAdapterInfo | undefined; // missing in older browsers
  const parts = [info?.vendor, info?.architecture, info?.description].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : 'unknown GPU';
}

// A device can be lost at any time: a driver update or crash, the GPU being
// reset, the browser reclaiming it. Most causes are temporary, so we recreate
// everything from a new adapter. But if losses keep happening, retrying
// forever would just flicker, so we stop after a few within a minute.
// https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost
export const MAX_RESTARTS_PER_WINDOW = 3;
export const RESTART_WINDOW_MS = 60_000;

export function shouldRestart(previousLossTimes: readonly number[], now: number): boolean {
  const recent = previousLossTimes.filter((t) => now - t < RESTART_WINDOW_MS);
  return recent.length < MAX_RESTARTS_PER_WINDOW;
}
