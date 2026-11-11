import shaderSource from './denoise.wgsl?raw';
import { createBufferWithData, logCompilationMessages } from '../gpu/shader.ts';
import { firstAndLast } from '../gpu/timer.ts';
import { type FilterInputs, needsFilter } from './denoise-schedule.ts';
import { DENOISE_WORKGROUP_SIZE, GUIDE_BYTES_PER_PIXEL, ILLUMINATION_BYTES_PER_PIXEL } from './gpu-layout.ts';
import { MAX_DENOISE_LEVEL } from './settings.ts';
import type { TracerOutput } from './tracer-pass.ts';

export interface DenoisePass {
  // Draws the tracer's image into `target`, smoothed by `image.level` filter
  // passes (1 to MAX_DENOISE_LEVEL), or as the plain average at level 0. It
  // only filters again when denoise-schedule.ts says so; otherwise it reuses
  // the last filtered light. `timestampWrites` measures all of its passes.
  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    input: TracerOutput,
    image: FilterInputs,
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
}

// The buffers and bind groups for one canvas size, rebuilt when it changes.
interface Bindings {
  frame: GPUBuffer;
  width: number;
  height: number;
  buffers: GPUBuffer[]; // the two illumination buffers and the guides
  atrous: GPUBindGroup[]; // [k] is pass k + 1: reads illumination[k % 2], writes the other
  // The groups that read the tracer's records. The tracer keeps two copies
  // and writes them in turn, so there's a set for each.
  forRecords(pixels: GPUBuffer): RecordBindings;
}

interface RecordBindings {
  prepare: GPUBindGroup;
  show: [GPUBindGroup, GPUBindGroup]; // [i] reads illumination[i]
  raw: GPUBindGroup;
}

interface Pipelines {
  prepare: GPUComputePipeline;
  atrous: GPUComputePipeline;
  show: GPURenderPipeline;
  raw: GPURenderPipeline;
}

export function createDenoisePass(device: GPUDevice, format: GPUTextureFormat): DenoisePass {
  const module = device.createShaderModule({ label: 'denoise', code: shaderSource });
  void logCompilationMessages(module, 'denoise.wgsl');

  // 'auto' layouts again: each pipeline's layout lists only the bindings its
  // entry point uses, which is why each gets its own bind groups below.
  const compute = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ label: `denoise · ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
  const show = (entryPoint: string): GPURenderPipeline =>
    device.createRenderPipeline({
      label: `denoise · ${entryPoint}`,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  const pipelines: Pipelines = {
    prepare: compute('prepare'),
    atrous: compute('atrous'),
    show: show('showDenoised'),
    raw: show('showRaw'),
  };

  // Each pass's grid spacing (1, 2, 4 … 512 pixels), in its own small
  // uniform buffer, written once. The shader reads one u32; the buffer holds
  // a whole vec4's worth (16 bytes), the unit uniform data is laid out in.
  const spacings = Array.from({ length: MAX_DENOISE_LEVEL }, (_, k) =>
    createBufferWithData(device, `denoise spacing ${2 ** k}`, new Uint32Array([2 ** k, 0, 0, 0]).buffer, GPUBufferUsage.UNIFORM),
  );

  let bindings: Bindings | null = null;
  let lastFilter: FilterInputs | null = null; // what the last filtered light came from
  let result = 0; // which illumination buffer holds it

  return {
    encode(encoder, target, input, image, timestampWrites) {
      if (bindings?.frame !== input.frame || bindings.width !== input.width || bindings.height !== input.height) {
        bindings = createBindings(device, input, bindings, spacings, pipelines);
        lastFilter = null;
      }
      const records = bindings.forRecords(input.pixels);

      const draw = (
        pipeline: GPURenderPipeline,
        bindGroup: GPUBindGroup,
        stamps: GPURenderPassTimestampWrites | undefined,
      ): void => {
        const pass = encoder.beginRenderPass({
          label: pipeline.label,
          colorAttachments: [{ view: target, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
          timestampWrites: stamps,
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
      };

      if (image.level <= 0) {
        draw(pipelines.raw, records.raw, timestampWrites);
        return;
      }
      if (!needsFilter(lastFilter, image)) {
        draw(pipelines.show, records.show[result === 0 ? 0 : 1], timestampWrites);
        return;
      }

      // All the compute steps go in one compute pass. WebGPU makes each
      // dispatch see everything the one before it wrote.
      // https://www.w3.org/TR/webgpu/#programming-model-resource-usages
      const stamps = firstAndLast(timestampWrites);
      const computePass = encoder.beginComputePass({ label: 'denoise', timestampWrites: stamps.first });
      const groupsX = Math.ceil(input.width / DENOISE_WORKGROUP_SIZE);
      const groupsY = Math.ceil(input.height / DENOISE_WORKGROUP_SIZE);
      computePass.setPipeline(pipelines.prepare);
      computePass.setBindGroup(0, records.prepare);
      computePass.dispatchWorkgroups(groupsX, groupsY);
      computePass.setPipeline(pipelines.atrous);
      const passes = Math.min(image.level, MAX_DENOISE_LEVEL);
      for (const bindGroup of bindings.atrous.slice(0, passes)) {
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(groupsX, groupsY);
      }
      computePass.end();

      // After `passes` filter passes, the result is in illumination[passes % 2].
      result = passes % 2;
      lastFilter = { ...image };
      draw(pipelines.show, records.show[result === 0 ? 0 : 1], stamps.last);
    },
  };
}

function createBindings(
  device: GPUDevice,
  input: TracerOutput,
  previous: Bindings | null,
  spacings: GPUBuffer[],
  pipelines: Pipelines,
): Bindings {
  for (const buffer of previous?.buffers ?? []) buffer.destroy();
  const pixels = input.width * input.height;
  const storage = (label: string, bytesPerPixel: number): GPUBuffer =>
    device.createBuffer({
      label: `${label} ${input.width}×${input.height}`,
      size: pixels * bytesPerPixel,
      usage: GPUBufferUsage.STORAGE,
    });
  const a = storage('illumination 0', ILLUMINATION_BYTES_PER_PIXEL);
  const b = storage('illumination 1', ILLUMINATION_BYTES_PER_PIXEL);
  const guides = storage('denoise guides', GUIDE_BYTES_PER_PIXEL);

  // The binding numbers match the @binding(n) declarations in denoise.wgsl.
  const group = (pipeline: GPUComputePipeline | GPURenderPipeline, label: string, buffers: Record<number, GPUBuffer>): GPUBindGroup =>
    device.createBindGroup({
      label: `denoise · ${label}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: Object.entries(buffers).map(([binding, buffer]) => ({ binding: Number(binding), resource: { buffer } })),
    });
  const { frame } = input;

  const made = new Map<GPUBuffer, RecordBindings>();
  return {
    frame,
    width: input.width,
    height: input.height,
    buffers: [a, b, guides],
    atrous: spacings.map((spacing, k) =>
      group(pipelines.atrous, `pass ${k + 1}`, {
        0: frame,
        2: k % 2 === 0 ? a : b,
        3: k % 2 === 0 ? b : a,
        4: spacing,
        6: guides,
      }),
    ),
    forRecords(pixels) {
      let found = made.get(pixels);
      if (!found) {
        found = {
          prepare: group(pipelines.prepare, 'prepare', { 0: frame, 1: pixels, 3: a, 5: guides }),
          show: [
            group(pipelines.show, 'show 0', { 0: frame, 1: pixels, 2: a }),
            group(pipelines.show, 'show 1', { 0: frame, 1: pixels, 2: b }),
          ],
          raw: group(pipelines.raw, 'raw', { 0: frame, 1: pixels }),
        };
        made.set(pixels, found);
      }
      return found;
    },
  };
}
