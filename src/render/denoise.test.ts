import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DENOISE_WORKGROUP_SIZE, PIXEL_RECORD_BYTES } from './gpu-layout.ts';

const tracer = readFileSync(new URL('./tracer.wgsl', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const denoise = readFileSync(new URL('./denoise.wgsl', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// A top-level declaration's text, from its first line to the "}" that
// closes it at the start of a line (or the single line, for a const).
function declaration(source: string, start: string): string {
  const from = source.indexOf(`\n${start}`);
  assert.ok(from >= 0, `no "${start}" found`);
  if (start.startsWith('const ')) return source.slice(from + 1, source.indexOf('\n', from + 1));
  const to = source.indexOf('\n}\n', from);
  return source.slice(from + 1, to + 2);
}

for (const start of [
  'struct Frame {',
  'struct PixelRecord {',
  'const NO_HIT =',
  'fn luminance(',
  'fn toneMap(',
  'fn encodeSrgb(',
  'fn screenColor(',
]) {
  test(`denoise.wgsl's copy of "${start}" matches tracer.wgsl`, () => {
    assert.equal(declaration(denoise, start), declaration(tracer, start));
  });
}

test('PixelRecord is four vec4f, as PIXEL_RECORD_BYTES says', () => {
  const fields = [...declaration(tracer, 'struct PixelRecord {').matchAll(/^ {2}\w+: (\w+),/gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['vec4f', 'vec4f', 'vec4f', 'vec4f']);
  assert.equal(PIXEL_RECORD_BYTES, fields.length * 16);
});

test('both compute steps use DENOISE_WORKGROUP_SIZE', () => {
  const sizes = [...denoise.matchAll(/@workgroup_size\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(sizes.length, 2);
  for (const size of sizes) assert.deepEqual(size, [DENOISE_WORKGROUP_SIZE, DENOISE_WORKGROUP_SIZE]);
});
