// The render layers and debug views that the Layers panel switches, for
// seeing what each part of the shader contributes. The shader reads them
// from struct Frame: the layers as bit flags, the view as a number.
// Must match the LAYER_* and VIEW_* constants in whitted.wgsl; layers.test.ts checks.

// One bit per layer, so all of them fit in a single u32: bit set = layer on.
export const LAYER_BITS = {
  sun: 1 << 0, // direct sunlight
  shadows: 1 << 1, // shadow rays toward the sun
  ambient: 1 << 2, // the fake fill light
  color: 1 << 3, // material colors; off = plain grey
  reflections: 1 << 4, // mirror bounces; off = mirrors are matte
  fog: 1 << 5, // distant surfaces fade into the sky
  sky: 1 << 6, // off = rays that hit nothing return black
  toneMap: 1 << 7, // off = brightness above 1 clips to white
  srgb: 1 << 8, // off = linear light goes to the screen unconverted
} as const;

export type Layer = keyof typeof LAYER_BITS;
export const LAYER_NAMES = Object.keys(LAYER_BITS) as Layer[];

// What the shader outputs instead of the final image. Except for "final",
// these show one ingredient of the image as false color.
export const VIEWS = {
  final: 0, // the lit image
  color: 1, // each surface's color with no lighting (albedo)
  normals: 2, // which way each surface faces
  distance: 3, // how far the ray travelled
  sunlight: 4, // lit, cast shadow, or facing away from the sun
  rays: 5, // how many rays the pixel cost
} as const;

export type View = keyof typeof VIEWS;
export const VIEW_NAMES = Object.keys(VIEWS) as View[];

// What the Layers panel edits and the frame loop reads.
export interface RenderSettings {
  layers: Record<Layer, boolean>;
  view: View;
  sunMoves: boolean; // off = the sun stands still, to study one shadow
}

export function defaultSettings(): RenderSettings {
  const layers = Object.fromEntries(LAYER_NAMES.map((name) => [name, true])) as Record<Layer, boolean>;
  return { layers, view: 'final', sunMoves: true };
}

// The bit flags for the layers that are on, as struct Frame's `layers`.
export function layerBits(layers: Record<Layer, boolean>): number {
  return LAYER_NAMES.reduce((bits, name) => (layers[name] ? bits | LAYER_BITS[name] : bits), 0);
}
