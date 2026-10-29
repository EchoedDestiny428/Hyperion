import { type Vec3, add, cross, scale } from '../math/vec3.ts';
import { type CameraBasis, type Orbit, orbitBasis, upsideDown, wrapAngle } from './orbit.ts';

// A floating camera: it moves freely in 3D (no gravity, no walls) and turns
// on the spot, all the way around in any direction. Its state is a position
// and two angles.
export interface Fly {
  position: Vec3;
  yaw: number; // radians around the vertical axis; 0 looks toward -z
  pitch: number; // radians above the horizon (negative = looking down); past ±π/2, upside down
  speed: number; // meters per second
}

const WORLD_UP: Vec3 = [0, 1, 0];

// Stay above the ground plane: it's one-sided, so from below it vanishes.
export const MIN_HEIGHT = 0.05;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 50;
export const FAST_MULTIPLIER = 4; // while Shift is held

export function flyForward(f: Fly): Vec3 {
  const c = Math.cos(f.pitch);
  return [-Math.sin(f.yaw) * c, Math.sin(f.pitch), -Math.cos(f.yaw) * c];
}

// As in orbitBasis, "up" is the direction the view turns as pitch grows, so
// looking straight up or down works, and so does going past it.
export function flyBasis(f: Fly): CameraBasis {
  const forward = flyForward(f);
  const s = Math.sin(f.pitch);
  const up: Vec3 = [Math.sin(f.yaw) * s, Math.cos(f.pitch), Math.cos(f.yaw) * s]; // d(forward)/d(pitch)
  const right = cross(forward, up);
  return { position: f.position, forward, right, up };
}

// The fly camera that sees exactly what this orbit camera sees. An orbit
// camera looks down at its target, so its pitch flips sign.
export function flyFromOrbit(o: Orbit, speed: number): Fly {
  return { position: orbitBasis(o).position, yaw: o.yaw, pitch: -o.pitch, speed };
}

// The orbit camera around the point `distance` ahead that sees the same view.
export function orbitFromFly(f: Fly, distance: number): Orbit {
  return { target: add(f.position, scale(flyForward(f), distance)), yaw: f.yaw, pitch: -f.pitch, distance };
}

// Which way the keys push: each -1, 0 or 1.
export interface FlyInput {
  forward: number; // W minus S
  right: number; // D minus A
  up: number; // E minus Q
  fast: boolean; // Shift
}

// Where the camera is after `seconds` of the given input. Forward follows
// the look direction, up and down, which is what makes it float.
export function moveFly(f: Fly, input: FlyInput, seconds: number): Fly {
  const { forward, right } = flyBasis(f);
  const direction = add(add(scale(forward, input.forward), scale(right, input.right)), scale(WORLD_UP, input.up));
  const length = Math.hypot(...direction);
  if (length === 0) return f;
  // Normalized, so moving diagonally isn't faster than straight.
  const distance = f.speed * (input.fast ? FAST_MULTIPLIER : 1) * seconds;
  const moved = add(f.position, scale(direction, distance / length));
  return { ...f, position: [moved[0], Math.max(moved[1], MIN_HEIGHT), moved[2]] };
}

// Dragging turns the view the way the mouse moves, as in a first-person
// game, with no limit: keep dragging up and you look backwards, upside down.
// dx/dy are in CSS pixels.
export function lookFly(f: Fly, dx: number, dy: number): Fly {
  const radiansPerPixel = 0.004;
  const turn = upsideDown(f.pitch) ? -1 : 1; // keeps "drag right, turn right" true upside down
  return {
    ...f,
    yaw: wrapAngle(f.yaw - dx * radiansPerPixel * turn),
    pitch: wrapAngle(f.pitch - dy * radiansPerPixel),
  };
}

// [ and ] change the speed by steps of ×1.5, so each press feels the same
// whether crawling past a bead or crossing the whole scene.
export const SPEED_STEP = 1.5;

export function changeFlySpeed(f: Fly, steps: number): Fly {
  return { ...f, speed: clamp(f.speed * SPEED_STEP ** steps, MIN_SPEED, MAX_SPEED) };
}

// Scrolling zooms by moving along the view, like the orbit camera's zoom. A
// wheel notch (deltaY ≈ 100) moves as far as a quarter second of flying, so
// it scales with the speed too.
export function dollyFly(f: Fly, wheelDeltaY: number): Fly {
  const distance = (-wheelDeltaY / 100) * f.speed * 0.25;
  const moved = add(f.position, scale(flyForward(f), distance));
  return { ...f, position: [moved[0], Math.max(moved[1], MIN_HEIGHT), moved[2]] };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// event.code names the physical key, so WASD stays in the same place on
// AZERTY and other layouts. https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code
const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

export interface FlyControls {
  input(): FlyInput;
  detach(): void;
}

// Keyboard on the whole window, mouse on the canvas. While `isActive()` is
// false, the mouse is left to the orbit controls, and a movement key calls
// `activate()` instead, which switches to flying.
export function attachFlyControls(
  element: HTMLElement,
  fly: Fly,
  isActive: () => boolean,
  activate: () => void,
): FlyControls {
  const held = new Set<string>();
  let dragging = false;

  // Keys typed into the panel's menus and sliders are theirs, not ours.
  const isFormControl = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isFormControl(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVEMENT_KEYS.has(e.code) && !isActive()) activate();
    // Holding [ or ] repeats the keydown, so the speed keeps changing.
    if (isActive() && e.code === 'BracketLeft') Object.assign(fly, changeFlySpeed(fly, -1));
    if (isActive() && e.code === 'BracketRight') Object.assign(fly, changeFlySpeed(fly, 1));
    held.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    held.delete(e.code);
  };
  // A key released while the window wasn't focused never sends keyup;
  // forget them all, or the camera would keep drifting.
  const onBlur = (): void => held.clear();

  const onDown = (e: PointerEvent): void => {
    if (!isActive()) return;
    dragging = true;
    element.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (dragging && isActive()) Object.assign(fly, lookFly(fly, e.movementX, e.movementY));
  };
  const onUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    element.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent): void => {
    if (!isActive()) return;
    e.preventDefault(); // otherwise the page itself would scroll/zoom
    Object.assign(fly, dollyFly(fly, e.deltaY));
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
      forward: pressed('KeyW') - pressed('KeyS'),
      right: pressed('KeyD') - pressed('KeyA'),
      up: pressed('KeyE') - pressed('KeyQ'),
      fast: held.has('ShiftLeft') || held.has('ShiftRight'),
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
