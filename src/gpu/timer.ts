// Measures how long the GPU spends on the render pass, using timestamp
// queries: the GPU writes its own clock into a query set when the pass starts
// and ends, and we copy the two values back to the CPU.
// https://www.w3.org/TR/webgpu/#timestamp
//
// This is the GPU's own time. It's not the time between frames, which the
// browser caps at the display's refresh rate however little work there is.

export const GPU_TIME_SAMPLES = 120; // recent measurements kept for percentiles

export interface GpuTimer {
  // For beginRenderPass's `timestampWrites`. Undefined when this frame isn't
  // timed, because the previous measurement is still being read back.
  passTimestamps(): GPURenderPassTimestampWrites | undefined;
  // After the pass: copies the timestamps somewhere the CPU can read.
  resolve(encoder: GPUCommandEncoder): void;
  // After submitting: reads them once the GPU has finished the frame.
  collect(): void;
  readonly times: readonly number[]; // milliseconds, oldest first
}

// Null when the browser or GPU doesn't offer the timestamp-query feature.
export function createGpuTimer(device: GPUDevice): GpuTimer | null {
  if (!device.features.has('timestamp-query')) return null;

  const querySet = device.createQuerySet({ label: 'pass timestamps', type: 'timestamp', count: 2 });
  // Query results can only be resolved into a QUERY_RESOLVE buffer, and only a
  // MAP_READ buffer can be read by the CPU, so the values go through both.
  const resolveBuffer = device.createBuffer({
    label: 'timestamps (resolve)',
    size: 16, // two 64-bit nanosecond counts
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    label: 'timestamps (read)',
    size: 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const times: number[] = [];
  // One measurement at a time: a mapped buffer can't be copied into, so
  // frames drawn while a result is on its way back simply aren't timed.
  let state: 'idle' | 'timing' | 'reading' = 'idle';

  return {
    times,
    passTimestamps() {
      if (state !== 'idle') return undefined;
      state = 'timing';
      return { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    },
    resolve(encoder) {
      if (state !== 'timing') return;
      encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16);
    },
    collect() {
      if (state !== 'timing') return;
      state = 'reading';
      readBuffer.mapAsync(GPUMapMode.READ).then(
        () => {
          const stamps = new BigUint64Array(readBuffer.getMappedRange());
          const begin = stamps[0];
          const end = stamps[1];
          readBuffer.unmap();
          // The spec allows nonsense values (such as end before begin) in
          // some cases, so only sensible ones are kept.
          if (begin !== undefined && end !== undefined && end > begin) {
            times.push(Number(end - begin) / 1e6);
            if (times.length > GPU_TIME_SAMPLES) times.shift();
          }
          state = 'idle';
        },
        () => {
          state = 'idle'; // mapping fails if the device was lost; nothing to measure then
        },
      );
    },
  };
}
