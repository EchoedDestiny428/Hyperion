// Reading screenshots and measuring how far apart two pictures are, for
// noise.ts. Screenshots come back as PNG files; Node can unzip PNG's data
// (zlib) but has no PNG reader, so the rest is here. PNG spec:
// https://www.w3.org/TR/png-3/

import { inflateSync } from 'node:zlib';

export interface Picture {
  width: number;
  height: number;
  rgb: Uint8Array; // red, green, blue for each pixel, row by row
}

// Reads an 8-bit RGB or RGBA PNG without interlacing, which is what browser
// screenshots are. Anything else is an error rather than a wrong picture.
export function decodePng(file: Uint8Array): Picture {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, i) => file[i] === byte)) throw new Error('Not a PNG file.');

  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Uint8Array[] = [];
  // After the signature, a PNG is a list of chunks: length, 4-letter type, data, checksum.
  for (let at = 8; at < file.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [bitDepth, colorType, , , interlace] = data.subarray(8, 13);
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG: bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}.`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  // Each row starts with a filter byte saying how its bytes were predicted
  // from the pixel to the left (a), above (b) and above-left (c). Undoing the
  // prediction row by row gives the real bytes.
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      const predicted =
        filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      pixels[y * stride + x] = ((row[x] ?? 0) + predicted) & 0xff;
    }
  }

  if (channels === 3) return { width, height, rgb: pixels };
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) rgb.set(pixels.subarray(i, i + 3), j);
  return { width, height, rgb };
}

// PNG's "Paeth" predictor: whichever neighbor is closest to a + b - c.
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Root-mean-square difference between two pictures, in screen values from 0
// to 255: roughly the typical size of the difference at each pixel. Against a
// clean reference picture, it measures noise.
export function rmsDifference(a: Picture, b: Picture): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`The pictures differ in size: ${a.width}×${a.height} and ${b.width}×${b.height}.`);
  }
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) {
    const d = (a.rgb[i] ?? 0) - (b.rgb[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum / a.rgb.length);
}
