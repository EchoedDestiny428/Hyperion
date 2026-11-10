// Sizes the shaders and the passes that run them must agree on. They live
// here, apart from tracer-pass.ts and denoise-pass.ts, so tests can import
// them: the pass files import .wgsl files, which only Vite knows how to load.
// denoise.test.ts checks them against the shaders.

// struct PixelRecord in tracer.wgsl and denoise.wgsl: three vec4f.
export const PIXEL_RECORD_BYTES = 48;

// The denoiser's illumination buffers: one vec4f per pixel.
export const ILLUMINATION_BYTES_PER_PIXEL = 16;

// The denoiser's guides (packGuide in denoise.wgsl): one vec4u per pixel.
export const GUIDE_BYTES_PER_PIXEL = 16;

// @workgroup_size(8, 8) in denoise.wgsl. 8×8 = 64 threads per group is a
// common choice: a multiple of every GPU's batch size (32 on NVIDIA, 8 to 32
// on Intel, 32 or 64 on AMD), so batches inside the image run full.
export const DENOISE_WORKGROUP_SIZE = 8;
