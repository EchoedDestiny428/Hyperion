import { type Vec3, add, scale } from '../math/vec3.ts';
import { SUN_RADIANS_PER_SECOND } from '../render/settings.ts';
import type { Fly } from './fly.ts';

// A camera move that's exactly the same every time it runs, for measuring
// how the picture holds up while the camera moves (scripts/motion.ts), or
// for watching it. Turned on from the address bar:
//
//   ?spin=0.5            press P to start turning the orbit camera 0.5° per frame
//   ?walk=0.02           press P to start walking the fly camera forward 2 cm per frame
//   &frames=60           ... and stop after 60 frames, holding the last picture
//   ?turn=30             start with the orbit camera turned 30° from the scene's view
//   ?ahead=1.2           start with the fly camera 1.2 m ahead of the scene's view
//   ?sun=0.5             press P to start turning the sun 0.5° per frame (camera still)
//   ?sunturn=30          start with the sun turned 30° around
//
// Orbiting moves the view mostly sideways; walking moves it forward, which
// makes things grow on screen and slide past each other, a different test.
// Turning the sun keeps the view still and changes the light instead.
// It moves a fixed amount per frame drawn, not per second, so frame 60 is
// always the same view, however fast the GPU is. With the random numbers
// already fixed by pixel and sample, the whole run is then repeatable. A
// still picture of frame 60's view is ?turn= (or ?ahead=) plus 60 steps.

export interface CameraPath {
  kind: 'spin' | 'walk' | 'sun';
  step: number; // per frame: degrees for a spin or the sun, meters for a walk; 0 = no moving, only the start
  frames: number; // moving stops after this many frames; Infinity if not given
  start: number; // where it starts, from the scene's own: degrees (?turn=, ?sunturn=) or meters (?ahead=)
}

// The path the address bar asks for, or null for none, and anything in it
// that couldn't be read (to show in the console rather than failing).
export function parseCameraPath(search: string): { path: CameraPath | null; problems: string[] } {
  const params = new URLSearchParams(search);
  const problems: string[] = [];
  const number = (name: string, valid: (value: number) => boolean, rule: string): number | undefined => {
    const text = params.get(name);
    if (text === null) return undefined;
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value) || !valid(value)) {
      problems.push(`?${name}=${text} isn't ${rule}, so it was ignored.`);
      return undefined;
    }
    return value;
  };
  const nonZero = (v: number): boolean => v !== 0;
  let spin = number('spin', nonZero, 'a number of degrees per frame other than 0');
  const walk = number('walk', nonZero, 'a number of meters per frame other than 0');
  const sun = number('sun', nonZero, 'a number of degrees per frame other than 0');
  const sunturn = number('sunturn', () => true, 'a number of degrees');
  if (sun !== undefined || sunturn !== undefined) {
    if (spin !== undefined || walk !== undefined || params.has('turn') || params.has('ahead')) {
      problems.push('?sun= turns the sun with the camera still, so it can\'t go with ?spin=, ?walk=, ?turn= or ?ahead=. Using ?sun=.');
    }
    const frames = number('frames', (v) => Number.isInteger(v) && v > 0, 'a whole number of frames above 0');
    return { path: { kind: 'sun', step: sun ?? 0, frames: frames ?? Infinity, start: sunturn ?? 0 }, problems };
  }
  const frames = number('frames', (v) => Number.isInteger(v) && v > 0, 'a whole number of frames above 0');
  const turn = number('turn', () => true, 'a number of degrees');
  const ahead = number('ahead', () => true, 'a number of meters');

  if (spin !== undefined && walk !== undefined) {
    problems.push('?spin= and ?walk= can\'t both be used: one turns the orbit camera, the other moves the fly camera. Using ?walk=.');
    spin = undefined;
  }
  const walking = walk !== undefined || (spin === undefined && ahead !== undefined);
  if (frames !== undefined && spin === undefined && walk === undefined) {
    problems.push('?frames= only means something with ?spin= or ?walk=, so it was ignored.');
  }
  if (walking && turn !== undefined) problems.push('?turn= is for ?spin=; a walk starts from ?ahead=. It was ignored.');
  if (!walking && ahead !== undefined) problems.push('?ahead= is for ?walk=; a spin starts from ?turn=. It was ignored.');
  if (spin === undefined && walk === undefined && turn === undefined && ahead === undefined) return { path: null, problems };

  const path: CameraPath = walking
    ? { kind: 'walk', step: walk ?? 0, frames: frames ?? Infinity, start: ahead ?? 0 }
    : { kind: 'spin', step: spin ?? 0, frames: frames ?? Infinity, start: turn ?? 0 };
  return { path, problems };
}

// The orbit camera's yaw after `frame` frames of a spin. Worked out from the
// start each time rather than added up frame by frame, so it's exactly what
// ?turn= gives for the same angle, with no rounding piling up.
export function spinYaw(startYaw: number, path: CameraPath, frame: number): number {
  return startYaw + ((path.start + frame * path.step) * Math.PI) / 180;
}

// The sun's clock (as "Sun moves" runs it) after `frame` frames of turning
// the sun: the time at which sunDirection() has turned that far. Worked out
// from the start each time, like spinYaw.
export function sunSeconds(path: CameraPath, frame: number): number {
  return ((path.start + frame * path.step) * Math.PI) / 180 / SUN_RADIANS_PER_SECOND;
}

// The fly camera's position after `frame` frames of a walk: straight ahead,
// level, whichever way it looks up or down, as a person walks. Worked out
// from the start each time, like spinYaw.
export function walkPosition(start: Pick<Fly, 'position' | 'yaw'>, path: CameraPath, frame: number): Vec3 {
  const ahead: Vec3 = [-Math.sin(start.yaw), 0, -Math.cos(start.yaw)];
  return add(start.position, scale(ahead, path.start + frame * path.step));
}
