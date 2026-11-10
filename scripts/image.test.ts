import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { type Picture, decodePng, rmsDifference } from './image.ts';

// A minimal PNG writer for the tests: each row gets the filter given for it,
// so every way a row can be predicted gets decoded at least once.
function encodePng(width: number, height: number, channels: 3 | 4, pixels: number[], filters: number[]): Uint8Array {
  const stride = width * channels;
  const at = (x: number, y: number): number => (x < 0 || y < 0 ? 0 : (pixels[y * stride + x] ?? 0));
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length] ?? 0;
    rows.push(filter);
    for (let x = 0; x < stride; x++) {
      const a = at(x - channels, y);
      const b = at(x, y - 1);
      const c = at(x - channels, y - 1);
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter] ?? 0;
      rows.push((at(x, y) - predicted) & 0xff);
    }
  }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, data, Buffer.alloc(4)]); // the checksum isn't checked
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type: RGBA or RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', new Uint8Array()),
  ]);
}

// A 3 × 5 picture whose bytes vary enough to exercise every predictor.
const width = 3;
const height = 5;
const rgba = Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i % 7) * 11) & 0xff);
const rgbOnly = rgba.filter((_, i) => i % 4 !== 3);

test('reads RGBA screenshots with every row filter, dropping alpha', () => {
  const picture = decodePng(encodePng(width, height, 4, rgba, [0, 1, 2, 3, 4]));
  assert.equal(picture.width, width);
  assert.equal(picture.height, height);
  assert.deepEqual([...picture.rgb], rgbOnly);
});

test('reads RGB pictures too', () => {
  const picture = decodePng(encodePng(width, height, 3, rgbOnly, [4, 3, 2, 1, 0]));
  assert.deepEqual([...picture.rgb], rgbOnly);
});

test('rejects what it cannot read', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Not a PNG/);
});

test('the difference is the root of the mean squared difference per channel', () => {
  const a: Picture = { width: 1, height: 2, rgb: new Uint8Array([0, 0, 0, 10, 10, 10]) };
  const b: Picture = { width: 1, height: 2, rgb: new Uint8Array([0, 0, 0, 0, 0, 0]) };
  assert.equal(rmsDifference(a, a), 0);
  assert.equal(rmsDifference(a, b), Math.sqrt(50)); // half the values differ by 10
  assert.throws(() => rmsDifference(a, { ...b, width: 2, height: 1 }), /differ in size/);
});
