import shaderSource from './whitted.wgsl?raw';
import { type Scene, packScene } from '../scene/scene.ts';
import { FRAME_UNIFORM_FLOATS, type FrameParams, packFrameUniforms } from './frame-uniforms.ts';

export interface WhittedPass {
  // Uploads `scene` to the GPU first if it isn't the one drawn last time.
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, params: FrameParams, scene: Scene): void;
}

// The GPU copy of one scene, and the bind group that points the shader at it.
interface SceneResources {
  scene: Scene;
  buffers: GPUBuffer[];
  bindGroup: GPUBindGroup;
}

// Everything here is created once, except the scene's buffers, which are
// rebuilt when the scene changes; encode() runs every frame.
export function createWhittedPass(device: GPUDevice, format: GPUTextureFormat): WhittedPass {
  const module = device.createShaderModule({ label: 'whitted', code: shaderSource });
  void logCompilationMessages(module, 'whitted.wgsl');

  const pipeline = device.createRenderPipeline({
    label: 'whitted',
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

  // Binding 0 is the per-frame values; bindings 1-3 are the scene.
  const uploadScene = (scene: Scene, previous: SceneResources | null): SceneResources => {
    const packed = packScene(scene);
    const info = createBufferWithData(device, `${scene.name} info`, packed.info, GPUBufferUsage.UNIFORM);
    const spheres = createBufferWithData(device, `${scene.name} spheres`, packed.spheres, GPUBufferUsage.STORAGE);
    const materials = createBufferWithData(device, `${scene.name} materials`, packed.materials, GPUBufferUsage.STORAGE);
    const bindGroup = device.createBindGroup({
      label: `whitted · ${scene.name}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: info } },
        { binding: 2, resource: { buffer: spheres } },
        { binding: 3, resource: { buffer: materials } },
      ],
    });
    // Frames already submitted still finish with the old buffers: destroy()
    // only frees their memory once the GPU is done with them.
    // https://www.w3.org/TR/webgpu/#dom-gpubuffer-destroy
    for (const buffer of previous?.buffers ?? []) buffer.destroy();
    return { scene, buffers: [info, spheres, materials], bindGroup };
  };

  let current: SceneResources | null = null;

  return {
    encode(encoder, target, params, scene) {
      if (current?.scene !== scene) current = uploadScene(scene, current);

      // writeBuffer is scheduled on the queue and completes before any
      // command buffer submitted after it, so this frame's draw sees these values.
      // https://www.w3.org/TR/webgpu/#dom-gpuqueue-writebuffer
      device.queue.writeBuffer(uniformBuffer, 0, packFrameUniforms(params, uniforms));

      const pass = encoder.beginRenderPass({
        label: 'whitted',
        colorAttachments: [{ view: target, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, current.bindGroup);
      pass.draw(3); // the full-screen triangle; the shader computes its corners
      pass.end();
    },
  };
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
