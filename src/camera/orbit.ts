import { type Vec3, add, cross, scale } from '../math/vec3.ts';

// An orbit camera circles a target point. Its state is two angles and a
// distance, which is easier to control with a mouse than a raw position.
export interface Orbit {
  target: Vec3;
  yaw: number; // radians around the vertical (y) axis
  pitch: number; // radians above the horizon; past ±π/2 the camera has gone over the top
  distance: number;
}

// Everything the shader needs to build a ray for each pixel: where the
// camera is and which way its forward/right/up directions point.
export interface CameraBasis {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export const MIN_DISTANCE = 2;
export const MAX_DISTANCE = 40;

// The camera can circle all the way around, over the top and under the
// ground. Building "up" as world up (0, 1, 0) would break down when looking
// straight up or down, where it lines up with the view. Instead "up" is the
// direction the camera moves as pitch grows: always at right angles to the
// view, and upside down past the top, like a camera on a ball joint.
export function orbitBasis(o: Orbit): CameraBasis {
  const cp = Math.cos(o.pitch);
  const sp = Math.sin(o.pitch);
  const cy = Math.cos(o.yaw);
  const sy = Math.sin(o.yaw);
  // Spherical to Cartesian: yaw = 0, pitch = 0 puts the camera on the +z
  // side of the target, looking toward -z.
  const outward: Vec3 = [cp * sy, sp, cp * cy]; // unit length
  const position = add(o.target, scale(outward, o.distance));
  const forward = scale(outward, -1);
  const up: Vec3 = [-sp * sy, cp, -sp * cy]; // d(outward)/d(pitch): unit length, ⟂ forward
  const right = cross(forward, up);
  return { position, forward, right, up };
}

// True while the camera is upside down, past the top or bottom. Left and
// right then appear swapped on screen, so turning is flipped to match.
export function upsideDown(pitch: number): boolean {
  return Math.cos(pitch) < 0;
}

// Keeps an angle within -π..π. Sines and cosines don't care, but the number
// stays readable instead of growing with every lap.
export function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

// Dragging moves the camera across the screen. dx/dy are in CSS pixels.
export function applyDrag(o: Orbit, dx: number, dy: number): Orbit {
  const radiansPerPixel = 0.005;
  const turn = upsideDown(o.pitch) ? -1 : 1;
  return {
    ...o,
    yaw: wrapAngle(o.yaw - dx * radiansPerPixel * turn),
    pitch: wrapAngle(o.pitch + dy * radiansPerPixel),
  };
}

// Zooming is multiplicative, so each wheel notch feels the same near and far.
export function applyZoom(o: Orbit, wheelDeltaY: number): Orbit {
  return {
    ...o,
    distance: clamp(o.distance * Math.exp(wheelDeltaY * 0.001), MIN_DISTANCE, MAX_DISTANCE),
  };
}

// Which way the arrow keys push: each -1, 0 or 1.
export interface OrbitInput {
  right: number; // → minus ←: turn the scene right, like dragging right (the camera circles to its left)
  up: number; // ↑ minus ↓: tilt the scene up, like dragging up (the camera sinks toward the ground)
}

const SPIN_RADIANS_PER_SECOND = 1.2;

// Where the camera is after holding the arrow keys for `seconds`.
export function spinOrbit(o: Orbit, input: OrbitInput, seconds: number): Orbit {
  if (input.right === 0 && input.up === 0) return o;
  const step = SPIN_RADIANS_PER_SECOND * seconds;
  const turn = upsideDown(o.pitch) ? -1 : 1;
  return {
    ...o,
    yaw: wrapAngle(o.yaw - input.right * step * turn),
    pitch: wrapAngle(o.pitch - input.up * step),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export interface OrbitControls {
  input(): OrbitInput;
  detach(): void;
}

// Wires mouse/touch input and the arrow keys to an orbit. Pointer events
// cover mouse, pen and touch with one API:
// https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
// Mutates `orbit` in place, but only while `isActive()` (the fly camera may
// own the mouse instead). An arrow key while inactive calls `activate()`,
// which switches back to orbiting.
export function attachOrbitControls(
  element: HTMLElement,
  orbit: Orbit,
  isActive: () => boolean,
  activate: () => void,
): OrbitControls {
  let dragging = false;
  const held = new Set<string>();

  // Arrow keys in the panel's menus and sliders are theirs, not ours.
  const isFormControl = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!ARROW_KEYS.has(e.code) || isFormControl(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault(); // arrows would otherwise scroll anything scrollable
    if (!isActive()) activate();
    held.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    held.delete(e.code);
  };
  // A key released while the window wasn't focused never sends keyup.
  const onBlur = (): void => held.clear();

  const onDown = (e: PointerEvent): void => {
    if (!isActive()) return;
    dragging = true;
    // Keep receiving moves even if the pointer leaves the canvas mid-drag.
    element.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (dragging && isActive()) Object.assign(orbit, applyDrag(orbit, e.movementX, e.movementY));
  };
  const onUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    element.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent): void => {
    if (!isActive()) return;
    e.preventDefault(); // otherwise the page itself would scroll/zoom
    Object.assign(orbit, applyZoom(orbit, e.deltaY));
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  // passive: false is required for preventDefault() to work on wheel events.
  element.addEventListener('wheel', onWheel, { passive: false });

  const pressed = (code: string): number => (held.has(code) ? 1 : 0);
  return {
    input: () => ({
      right: pressed('ArrowRight') - pressed('ArrowLeft'),
      up: pressed('ArrowUp') - pressed('ArrowDown'),
    }),
    detach: () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('wheel', onWheel);
    },
  };
}
