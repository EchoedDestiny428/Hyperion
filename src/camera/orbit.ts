import { type Vec3, add, cross, normalize, scale, sub } from '../math/vec3.ts';

// An orbit camera circles a target point. Its state is two angles and a
// distance, which is easier to control with a mouse than a raw position.
export interface Orbit {
  target: Vec3;
  yaw: number; // radians around the vertical (y) axis
  pitch: number; // radians above the horizon
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

const WORLD_UP: Vec3 = [0, 1, 0];

// Keep the camera above the ground plane and away from straight up/down,
// where "right" (computed from forward × up) would become undefined.
export const MIN_PITCH = 0.03;
export const MAX_PITCH = 1.45;
export const MIN_DISTANCE = 2;
export const MAX_DISTANCE = 40;

export function orbitBasis(o: Orbit): CameraBasis {
  // Spherical to Cartesian: yaw = 0, pitch = 0 puts the camera on the +z
  // side of the target, looking toward -z.
  const offset: Vec3 = [
    o.distance * Math.cos(o.pitch) * Math.sin(o.yaw),
    o.distance * Math.sin(o.pitch),
    o.distance * Math.cos(o.pitch) * Math.cos(o.yaw),
  ];
  const position = add(o.target, offset);
  const forward = normalize(sub(o.target, position));
  const right = normalize(cross(forward, WORLD_UP));
  const up = cross(right, forward); // already unit length: right ⟂ forward
  return { position, forward, right, up };
}

// Dragging moves the camera across the screen. dx/dy are in CSS pixels.
export function applyDrag(o: Orbit, dx: number, dy: number): Orbit {
  const radiansPerPixel = 0.005;
  return {
    ...o,
    yaw: o.yaw - dx * radiansPerPixel,
    pitch: clamp(o.pitch + dy * radiansPerPixel, MIN_PITCH, MAX_PITCH),
  };
}

// Zooming is multiplicative, so each wheel notch feels the same near and far.
export function applyZoom(o: Orbit, wheelDeltaY: number): Orbit {
  return {
    ...o,
    distance: clamp(o.distance * Math.exp(wheelDeltaY * 0.001), MIN_DISTANCE, MAX_DISTANCE),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// Wires mouse/touch input to an orbit. Pointer events cover mouse, pen and
// touch with one API: https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
// Mutates `orbit` in place. Returns a function that removes the listeners.
export function attachOrbitControls(element: HTMLElement, orbit: Orbit): () => void {
  let dragging = false;

  const onDown = (e: PointerEvent): void => {
    dragging = true;
    // Keep receiving moves even if the pointer leaves the canvas mid-drag.
    element.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (dragging) Object.assign(orbit, applyDrag(orbit, e.movementX, e.movementY));
  };
  const onUp = (e: PointerEvent): void => {
    dragging = false;
    element.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // otherwise the page itself would scroll/zoom
    Object.assign(orbit, applyZoom(orbit, e.deltaY));
  };

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  // passive: false is required for preventDefault() to work on wheel events.
  element.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    element.removeEventListener('wheel', onWheel);
  };
}
