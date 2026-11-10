import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_DENOISE_LEVEL, RENDERERS, VIEWS, defaultSettings, denoiseLevel, denoiseReach } from './settings.ts';

// The shader's constants with a given prefix, keyed by the TypeScript name:
// VIEW_FINAL = 0u becomes { final: 0 }.
function shaderConstants(prefix: string): Record<string, number> {
  const wgsl = readFileSync(new URL('./tracer.wgsl', import.meta.url), 'utf8');
  const pattern = new RegExp(`^const ${prefix}_(\\w+) = (\\d+)u;`, 'gm');
  return Object.fromEntries(
    [...wgsl.matchAll(pattern)].map((m) => [
      (m[1] ?? '').toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
      Number(m[2]),
    ]),
  );
}

test('renderer numbers match the RENDERER_* constants in tracer.wgsl', () => {
  assert.deepEqual(shaderConstants('RENDERER'), RENDERERS);
});

test('view numbers match the VIEW_* constants in tracer.wgsl', () => {
  assert.deepEqual(shaderConstants('VIEW'), VIEWS);
});

test("only the path tracer's final image is denoised", () => {
  const settings = { ...defaultSettings(), denoise: 3 };
  assert.equal(denoiseLevel(settings), 3);
  assert.equal(denoiseLevel({ ...settings, renderer: 'whitted' }), 0);
  assert.equal(denoiseLevel({ ...settings, view: 'normals' }), 0);
});

test('denoise reach doubles plus two with each pass', () => {
  assert.deepEqual(
    Array.from({ length: MAX_DENOISE_LEVEL + 1 }, (_, level) => denoiseReach(level)),
    [0, 2, 6, 14, 30, 62],
  );
});
