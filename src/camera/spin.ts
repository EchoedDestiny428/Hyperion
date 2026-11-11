// A camera move that's exactly the same every time it runs, for measuring
// how the picture holds up while the camera moves (scripts/motion.ts), or
// for watching it. Turned on from the address bar:
//
//   ?spin=0.5            press P to start turning the orbit camera 0.5° per frame
//   ?spin=0.5&frames=60  ... and stop after 60 frames, holding the last picture
//   ?turn=30             start with the orbit camera turned 30° from the scene's view
//
// It turns by a fixed angle per frame drawn, not per second, so frame 60 is
// always the same view, however fast the GPU is. With the random numbers
// already fixed by pixel and sample, the whole run is then repeatable. A
// still picture of frame 60's view is ?turn= the starting turn plus 60 × spin.

export interface Spin {
  degreesPerFrame: number; // 0: no turning, only ?turn
  frames: number; // turning stops after this many frames; Infinity if not given
  turnDegrees: number; // where it starts, from the scene's own view
}

// The spin the address bar asks for, or null for none, and anything in it
// that couldn't be read (to show in the console rather than failing).
export function parseSpin(search: string): { spin: Spin | null; problems: string[] } {
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
  const degreesPerFrame = number('spin', (v) => v !== 0, 'a number of degrees per frame other than 0');
  const frames = number('frames', (v) => Number.isInteger(v) && v > 0, 'a whole number of frames above 0');
  const turnDegrees = number('turn', () => true, 'a number of degrees');
  if (frames !== undefined && degreesPerFrame === undefined) {
    problems.push('?frames= only means something with ?spin=, so it was ignored.');
  }
  if (degreesPerFrame === undefined && turnDegrees === undefined) return { spin: null, problems };
  return {
    spin: { degreesPerFrame: degreesPerFrame ?? 0, frames: frames ?? Infinity, turnDegrees: turnDegrees ?? 0 },
    problems,
  };
}

// The orbit camera's yaw after `frame` frames of turning. Worked out from the
// start each time rather than added up frame by frame, so it's exactly what
// ?turn= gives for the same angle, with no rounding piling up.
export function spinYaw(startYaw: number, spin: Spin, frame: number): number {
  return startYaw + ((spin.turnDegrees + frame * spin.degreesPerFrame) * Math.PI) / 180;
}
