import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYER_BITS, LAYER_NAMES, VIEWS, defaultSettings, layerBits } from './layers.ts';

// The shader's constants with a given prefix, keyed by the TypeScript name:
// LAYER_TONE_MAP = 128u becomes { toneMap: 128 }.
function shaderConstants(prefix: string): Record<string, number> {
  const wgsl = readFileSync(new URL('./whitted.wgsl', import.meta.url), 'utf8');
  const pattern = new RegExp(`^const ${prefix}_(\\w+) = (\\d+)u;`, 'gm');
  return Object.fromEntries(
    [...wgsl.matchAll(pattern)].map((m) => [
      (m[1] ?? '').toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
      Number(m[2]),
    ]),
  );
}

test('layer bits match the LAYER_* constants in whitted.wgsl', () => {
  assert.deepEqual(shaderConstants('LAYER'), LAYER_BITS);
});

test('view numbers match the VIEW_* constants in whitted.wgsl', () => {
  assert.deepEqual(shaderConstants('VIEW'), VIEWS);
});

test('each layer has its own bit', () => {
  const bits = Object.values(LAYER_BITS);
  assert.equal(new Set(bits).size, bits.length);
  for (const bit of bits) assert.equal(bit & (bit - 1), 0, `${bit} is not a single bit`);
});

test('layerBits sets exactly the bits of the layers that are on', () => {
  const { layers } = defaultSettings();
  assert.equal(layerBits(layers), (1 << LAYER_NAMES.length) - 1);

  for (const name of LAYER_NAMES) layers[name] = false;
  assert.equal(layerBits(layers), 0);

  layers.shadows = true;
  assert.equal(layerBits(layers), LAYER_BITS.shadows);
});
