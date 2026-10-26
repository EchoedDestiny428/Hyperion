import shaderSource from './whitted.wgsl?raw';
import { FRAME_UNIFORM_FLOATS, type FrameParams, packFrameUniforms } from './frame-uniforms.ts';

export interface WhittedPass {
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, params: FrameParams): void;
}

// Everything here is created once; encode() runs every frame.
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

  const bindGroup = device.createBindGroup({
    label: 'whitted',
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const uniforms = new Float32Array(FRAME_UNIFORM_FLOATS); // reused every frame

  return {
    encode(encoder, target, params) {
      // writeBuffer is scheduled on the queue and completes before any
      // command buffer submitted after it, so this frame's draw sees these values.
      // https://www.w3.org/TR/webgpu/#dom-gpuqueue-writebuffer
      device.queue.writeBuffer(uniformBuffer, 0, packFrameUniforms(params, uniforms));

      const pass = encoder.beginRenderPass({
        label: 'whitted',
        colorAttachments: [{ view: target, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3); // the full-screen triangle; the shader computes its corners
      pass.end();
    },
  };
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
