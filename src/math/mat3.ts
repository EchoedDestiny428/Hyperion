import type { Vec3 } from './vec3.ts';

// A 3×3 matrix stored as its three columns, the way WGSL's mat3x3f is. For
// a rotation, the columns are where the x, y and z axes end up.
export type Mat3 = [Vec3, Vec3, Vec3];

export const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// m × v: a mix of m's columns, weighted by v's components.
export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  const [a, b, c] = m;
  return [
    a[0] * v[0] + b[0] * v[1] + c[0] * v[2],
    a[1] * v[0] + b[1] * v[1] + c[1] * v[2],
    a[2] * v[0] + b[2] * v[1] + c[2] * v[2],
  ];
}

// a × b: first b, then a.
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  return [applyMat3(a, b[0]), applyMat3(a, b[1]), applyMat3(a, b[2])];
}

// A rotation by angles in degrees about the x, y and z axes, applied in that
// order. Each turns by the right-hand rule: thumb along the axis, fingers
// curl the way it turns.
export function rotationFromDegrees([x, y, z]: Vec3): Mat3 {
  const r = Math.PI / 180;
  const [cx, sx] = [Math.cos(x * r), Math.sin(x * r)];
  const [cy, sy] = [Math.cos(y * r), Math.sin(y * r)];
  const [cz, sz] = [Math.cos(z * r), Math.sin(z * r)];
  const aboutX: Mat3 = [
    [1, 0, 0],
    [0, cx, sx],
    [0, -sx, cx],
  ];
  const aboutY: Mat3 = [
    [cy, 0, -sy],
    [0, 1, 0],
    [sy, 0, cy],
  ];
  const aboutZ: Mat3 = [
    [cz, sz, 0],
    [-sz, cz, 0],
    [0, 0, 1],
  ];
  return multiplyMat3(aboutZ, multiplyMat3(aboutY, aboutX));
}
