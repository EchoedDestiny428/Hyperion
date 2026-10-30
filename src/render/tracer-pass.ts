import shaderSource from './tracer.wgsl?raw';
import { type Scene, packScene } from '../scene/scene.ts';
import { FRAME_UNIFORM_FLOATS, type FrameParams, packFrameUniforms } from './frame-uniforms.ts';

export interface TracerPass {
  // Uploads `scene` to the GPU first if it isn't the one drawn last time, and
  // resizes the accumulation buffer if the canvas size changed.
  // `timestampWrites` (from gpu/timer.ts) measures the pass's GPU time.
  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    params: FrameParams,
    scene: Scene,
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
}

// The GPU copy of one scene: one buffer per part of packScene()'s result.
interface SceneBuffers {
  scene: Scene;
  info: GPUBuffer;
  spheres: GPUBuffer;
  materials: GPUBuffer;
  boxes: GPUBuffer;
  lights: GPUBuffer;
}

// The running total of samples, one vec4f (16 bytes) per pixel.
interface Accumulation {
  width: number;
  height: number;
  buffer: GPUBuffer;
}

const ACCUMULATION_BYTES_PER_PIXEL = 16;

// Everything here is created once, except the scene's buffers and the
// accumulation buffer, which are rebuilt when the scene or canvas size
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
  let accumulation: Accumulation | null = null;
  let bindGroup: GPUBindGroup | null = null; // points the shader at all of the above

  return {
    encode(encoder, target, params, scene, timestampWrites) {
      if (sceneBuffers?.scene !== scene) {
        sceneBuffers = uploadScene(device, scene, sceneBuffers);
        bindGroup = null;
      }
      if (accumulation?.width !== params.width || accumulation.height !== params.height) {
        accumulation = createAccumulation(device, params.width, params.height, accumulation);
        bindGroup = null;
      }
      // The binding numbers match the @binding(n) declarations in tracer.wgsl.
      bindGroup ??= device.createBindGroup({
        label: `tracer · ${scene.name}`,
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: sceneBuffers.info } },
          { binding: 2, resource: { buffer: sceneBuffers.spheres } },
          { binding: 3, resource: { buffer: sceneBuffers.materials } },
          { binding: 4, resource: { buffer: accumulation.buffer } },
          { binding: 5, resource: { buffer: sceneBuffers.boxes } },
          { binding: 6, resource: { buffer: sceneBuffers.lights } },
        ],
      });

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
      pass.setBindGroup(0, bindGroup);
      pass.draw(3); // the full-screen triangle; the shader computes its corners
      pass.end();
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
  };
  // Frames already submitted still finish with the old buffers: destroy()
  // only frees their memory once the GPU is done with them.
  // https://www.w3.org/TR/webgpu/#dom-gpubuffer-destroy
  if (previous) {
    for (const buffer of [previous.info, previous.spheres, previous.materials, previous.boxes, previous.lights]) {
      buffer.destroy();
    }
  }
  return uploaded;
}

// The running total needs no initial contents: the first sample after any
// change overwrites it rather than adding to it.
function createAccumulation(
  device: GPUDevice,
  width: number,
  height: number,
  previous: Accumulation | null,
): Accumulation {
  previous?.buffer.destroy();
  let size = width * height * ACCUMULATION_BYTES_PER_PIXEL;
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (size > limit) {
    const mb = (bytes: number): string => `${Math.round(bytes / 2 ** 20)} MB`;
    console.warn(
      `[accumulation] A ${width}×${height} canvas needs ${mb(size)} for its running total, but this GPU allows ` +
        `${mb(limit)} in one buffer, so the image won't refine. Make the window smaller to fix it.`,
    );
    size = ACCUMULATION_BYTES_PER_PIXEL; // a single element; the shader then skips accumulating
  }
  const buffer = device.createBuffer({ label: `accumulation ${width}×${height}`, size, usage: GPUBufferUsage.STORAGE });
  return { width, height, buffer };
}

// A buffer holding `data`, which shaders read as `usage` (UNIFORM or STORAGE).
function createBufferWithData(
  device: GPUDevice,
  label: string,
  data: ArrayBuffer,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

// Shader compile errors and warnings, with line numbers, in the console.
// Without this you only get a generic "invalid pipeline" error.
async function logCompilationMessages(module: GPUShaderModule, fileName: string): Promise<void> {
  const info = await module.getCompilationInfo();
  for (const m of info.messages) {
    const text = `[WGSL ${m.type}] ${fileName}:${m.lineNum}:${m.linePos} ${m.message}`;
    if (m.type === 'error') console.error(text);
    else if (m.type === 'warning') console.warn(text);
    else console.info(text);
  }
}
