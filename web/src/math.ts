export type Vec3 = [number, number, number];
export type Plane = [number, number, number, number];

export const V = {
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sc: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const t = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = t / aspect;
  m[5] = t;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  const z = V.norm(V.sub(eye, center));
  const x = V.norm(V.cross(up, z));
  const y = V.cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -V.dot(x, eye); m[13] = -V.dot(y, eye); m[14] = -V.dot(z, eye); m[15] = 1;
  return m;
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** The six clip planes of a view-projection matrix, normalized, facing inward. */
export function frustumPlanes(m: Float32Array): Plane[] {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r3 = row(3);
  const out: Plane[] = [];
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]] as const) {
    const a = row(axis);
    const p = [r3[0] + sign * a[0], r3[1] + sign * a[1], r3[2] + sign * a[2], r3[3] + sign * a[3]];
    const l = Math.hypot(p[0], p[1], p[2]);
    out.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
  }
  return out;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** `#rrggbb` to components in 0..1. */
export function hexColor(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Point on the sky at distance r; angles in degrees. */
export function sky(r: number, ra: number, dec: number): Vec3 {
  const a = (ra * Math.PI) / 180;
  const d = (dec * Math.PI) / 180;
  return [r * Math.cos(d) * Math.cos(a), r * Math.cos(d) * Math.sin(a), r * Math.sin(d)];
}
