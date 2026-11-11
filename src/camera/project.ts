import { type Vec3, add, dot, scale, sub } from '../math/vec3.ts';
import type { CameraBasis } from './orbit.ts';

// Where a point in the world lands on screen for a given camera: the inverse
// of how tracer.wgsl's fs() aims a ray through a pixel. The shader has its
// own copy (projectToPixel in tracer.wgsl); this one is for tests, which
// check that the two directions agree.
//
// Pixel coordinates run from the top-left corner, y down, so a pixel's
// center is at (i + 0.5, j + 0.5).

export interface Screen {
  width: number;
  height: number;
  verticalFovRadians: number;
}

// The direction fs() aims through a point on the screen, not normalized:
// forward + right × x + up × y, scaled so its forward part is exactly 1.
export function rayThroughPixel(camera: CameraBasis, screen: Screen, pixel: [number, number]): Vec3 {
  const tanHalf = Math.tan(screen.verticalFovRadians / 2);
  const aspect = screen.width / screen.height;
  const x = (pixel[0] / screen.width) * 2 - 1;
  const y = 1 - (pixel[1] / screen.height) * 2;
  return add(camera.forward, add(scale(camera.right, x * tanHalf * aspect), scale(camera.up, y * tanHalf)));
}

// Where `point` lands on screen, in pixels; null if it's behind the camera.
export function projectToPixel(camera: CameraBasis, screen: Screen, point: Vec3): [number, number] | null {
  const d = sub(point, camera.position);
  const depth = dot(d, camera.forward);
  if (depth <= 0) return null;
  const tanHalf = Math.tan(screen.verticalFovRadians / 2);
  const aspect = screen.width / screen.height;
  const x = dot(d, camera.right) / (depth * tanHalf * aspect);
  const y = dot(d, camera.up) / (depth * tanHalf);
  return [((x + 1) / 2) * screen.width, ((1 - y) / 2) * screen.height];
}
