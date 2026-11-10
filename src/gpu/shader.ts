// Small helpers shared by the render passes.

// Shader compile errors and warnings, with line numbers, in the console.
// Without this you only get a generic "invalid pipeline" error.
export async function logCompilationMessages(module: GPUShaderModule, fileName: string): Promise<void> {
  const info = await module.getCompilationInfo();
  for (const m of info.messages) {
    const text = `[WGSL ${m.type}] ${fileName}:${m.lineNum}:${m.linePos} ${m.message}`;
    if (m.type === 'error') console.error(text);
    else if (m.type === 'warning') console.warn(text);
    else console.info(text);
  }
}

// A buffer holding `data`, which shaders read as `usage` (UNIFORM or STORAGE).
export function createBufferWithData(
  device: GPUDevice,
  label: string,
  data: ArrayBuffer,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
