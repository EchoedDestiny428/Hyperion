// When the denoiser runs its filter again. On an integrated laptop GPU (Iris
// Xe, on battery), 2 passes at 1280×800 first cost 49 ms, 40% on top of a
// 117 ms dreamspace sample, and several times a whole sample of a simple
// scene. But one more sample barely changes the image once it holds a few
// dozen, so the filter only runs again when the sample count has grown by a
// tenth. In between, the screen multiplies the last filtered light by the
// latest colors (denoise-pass.ts), which looks the same.
//
// Up to 10 samples that's every sample; to reach 1,024 it's about 60 filters
// instead of 1,024. While the camera moves, every frame starts a new image,
// so every frame is filtered.

// A tenth, as a fraction of whole numbers: in floating point 100 × 1.1 is
// 110.00000000000001, which 110 samples would never reach.
const GROWTH_NUMERATOR = 11;
const GROWTH_DENOMINATOR = 10;

// What a filtered image came from.
export interface FilterInputs {
  generation: number; // counts restarts of the running total: a new one means a new image
  samples: number; // in the running total
  level: number; // filter passes
  finished: boolean; // the image holds all the samples it's going to get
}

export function needsFilter(last: FilterInputs | null, now: FilterInputs): boolean {
  if (!last || last.generation !== now.generation || last.level !== now.level) return true;
  if (now.samples <= last.samples) return false;
  // The finished image always gets a fresh filter, so it's the best one.
  return now.finished || now.samples * GROWTH_DENOMINATOR >= last.samples * GROWTH_NUMERATOR;
}
