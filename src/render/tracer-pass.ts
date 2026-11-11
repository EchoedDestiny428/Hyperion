import shaderSource from './tracer.wgsl?raw';
import { type Scene, packScene } from '../scene/scene.ts';
import { createBufferWithData, logCompilationMessages } from '../gpu/shader.ts';
import { FRAME_UNIFORM_FLOATS, type FrameParams, packFrameUniforms } from './frame-uniforms.ts';
import { PIXEL_RECORD_BYTES } from './gpu-layout.ts';

// The per-pixel records (struct PixelRecord in tracer.wgsl), which the
// denoiser reads, with the frame uniforms they were drawn with.
export interface TracerOutput {
  frame: GPUBuffer; // struct Frame
  pixels: GPUBuffer; // one PixelRecord per pixel, row by row
  width: number;
  height: number;
}

export interface TracerPass {
  // Uploads `scene` to the GPU first if it isn't the one drawn last time, and
  // resizes the per-pixel records if the canvas size changed.
  // `timestampWrites` (from gpu/timer.ts) measures the pass's GPU time.
  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    params: FrameParams,
    scene: Scene,
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
  // What the last encode() wrote (the copy of the records it wrote). Null
  // before the first one, and when the canvas is too big for the records
  // (see createRecords).
  output(): TracerOutput | null;
}

// The GPU copy of one scene: one buffer per part of packScene()'s result.
interface SceneBuffers {
  scene: Scene;
  info: GPUBuffer;
  spheres: GPUBuffer;
  materials: GPUBuffer;
  boxes: GPUBuffer;
  lights: GPUBuffer;
  bvhNodes: GPUBuffer;
  bvhItems: GPUBuffer;
}

// The running totals and G-buffer, one PixelRecord per pixel.
// The running totals and G-buffer, one PixelRecord per pixel, in two copies
// that take turns: each frame reads one and writes the other (see the
// Accumulation section of tracer.wgsl).
interface Records {
  width: number;
  height: number;
  buffers: [GPUBuffer, GPUBuffer];
  complete: boolean; // false if the canvas was too big and each holds a single record
}

// Everything here is created once, except the scene's buffers and the
// per-pixel records, which are rebuilt when the scene or canvas size
// changes; encode() runs every frame.
export function createTracerPass(device: GPUDevice, format: GPUTextureFormat): TracerPass {
  const module = device.createShaderModule({ label: 'tracer', code: shaderSource });
  void logCompilationMessages(module, 'tracer.wgsl');

  const pipeline = device.createRenderPipeline({
    label: 'tracer',
    // 'auto' derives the bind group layout from the shader's @group/@binding
    // declarations. Fine while only this pipeline uses it.
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const uniformBuffer = device.createBuffer({
    label: 'frame uniforms',
    size: FRAME_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
    // UNIFORM: shaders read it as var<uniform>. COPY_DST: we may write into
    // it from the CPU with queue.writeBuffer.
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uniforms = new Float32Array(FRAME_UNIFORM_FLOATS); // reused every frame

  let sceneBuffers: SceneBuffers | null = null;
  let records: Records | null = null;
  // Point the shader at all of the above: [i] reads records.buffers[i] and
  // writes the other.
  let bindGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  let written = 1; // which copy the last frame wrote

  return {
    encode(encoder, target, params, scene, timestampWrites) {
      if (sceneBuffers?.scene !== scene) {
        sceneBuffers = uploadScene(device, scene, sceneBuffers);
        bindGroups = null;
      }
      if (records?.width !== params.width || records.height !== params.height) {
        records = createRecords(device, params.width, params.height, records);
        bindGroups = null;
      }
      // The binding numbers match the @binding(n) declarations in tracer.wgsl.
      const scenePart = sceneBuffers;
      const copies = records.buffers;
      const group = (read: 0 | 1): GPUBindGroup =>
        device.createBindGroup({
          label: `tracer · ${scene.name} · reads copy ${read}`,
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: scenePart.info } },
            { binding: 2, resource: { buffer: scenePart.spheres } },
            { binding: 3, resource: { buffer: scenePart.materials } },
            { binding: 4, resource: { buffer: copies[read] } },
            { binding: 5, resource: { buffer: scenePart.boxes } },
            { binding: 6, resource: { buffer: scenePart.lights } },
            { binding: 7, resource: { buffer: scenePart.bvhNodes } },
            { binding: 8, resource: { buffer: scenePart.bvhItems } },
            { binding: 9, resource: { buffer: copies[read === 0 ? 1 : 0] } },
          ],
        });
      bindGroups ??= [group(0), group(1)];
      // Read what the last frame wrote, and write the other copy.
      const read = written === 0 ? 0 : 1;
      written = read === 0 ? 1 : 0;

      // writeBuffer is scheduled on the queue and completes before any
      // command buffer submitted after it, so this frame's draw sees these values.
      // https://www.w3.org/TR/webgpu/#dom-gpuqueue-writebuffer
      device.queue.writeBuffer(uniformBuffer, 0, packFrameUniforms(params, uniforms));

      const pass = encoder.beginRenderPass({
        label: 'tracer',
        colorAttachments: [{ view: target, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
        timestampWrites, // undefined counts as not given
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroups[read]);
      pass.draw(3); // the full-screen triangle; the shader computes its corners
      pass.end();
    },
    output() {
      if (!records?.complete) return null;
      return {
        frame: uniformBuffer,
        pixels: records.buffers[written === 0 ? 0 : 1],
        width: records.width,
        height: records.height,
      };
    },
  };
}

function uploadScene(device: GPUDevice, scene: Scene, previous: SceneBuffers | null): SceneBuffers {
  const packed = packScene(scene);
  const storage = (part: string, data: ArrayBuffer): GPUBuffer =>
    createBufferWithData(device, `${scene.name} ${part}`, data, GPUBufferUsage.STORAGE);
  const uploaded: SceneBuffers = {
    scene,
    info: createBufferWithData(device, `${scene.name} info`, packed.info, GPUBufferUsage.UNIFORM),
    spheres: storage('spheres', packed.spheres),
    materials: storage('materials', packed.materials),
    boxes: storage('boxes', packed.boxes),
    lights: storage('lights', packed.lights),
    bvhNodes: storage('BVH nodes', packed.bvhNodes),
    bvhItems: storage('BVH items', packed.bvhItems),
  };
  // Frames already submitted still finish with the old buffers: destroy()
  // only frees their memory once the GPU is done with them.
  // https://www.w3.org/TR/webgpu/#dom-gpubuffer-destroy
  if (previous) {
    const { info, spheres, materials, boxes, lights, bvhNodes, bvhItems } = previous;
    for (const buffer of [info, spheres, materials, boxes, lights, bvhNodes, bvhItems]) {
      buffer.destroy();
    }
  }
  return uploaded;
}

// The records need no initial contents: the first sample after any change
// overwrites them rather than adding to them.
function createRecords(device: GPUDevice, width: number, height: number, previous: Records | null): Records {
  for (const buffer of previous?.buffers ?? []) buffer.destroy();
  let size = width * height * PIXEL_RECORD_BYTES;
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const complete = size <= limit;
  if (!complete) {
    const mb = (bytes: number): string => `${Math.round(bytes / 2 ** 20)} MB`;
    console.warn(
      `[accumulation] A ${width}×${height} canvas needs ${mb(size)} for its running totals, but this GPU allows ` +
        `${mb(limit)} in one buffer, so the image won't refine or denoise. Make the window smaller to fix it.`,
    );
    size = PIXEL_RECORD_BYTES; // a single record; the shader then skips accumulating
  }
  const copy = (i: number): GPUBuffer =>
    device.createBuffer({ label: `pixel records ${i} ${width}×${height}`, size, usage: GPUBufferUsage.STORAGE });
  return { width, height, buffers: [copy(0), copy(1)], complete };
}
