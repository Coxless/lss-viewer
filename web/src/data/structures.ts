import type { Vec3 } from '../math';

/** See `structures.json` in docs/format.md. */
export type Geometry =
  | { shape: 'sphere'; center: Vec3; radius: number }
  | { shape: 'sky-box'; ra: [number, number]; dec: [number, number]; r: [number, number] };

export interface Structure {
  id: string;
  name: string;
  type: 'cluster' | 'supercluster' | 'wall' | 'void';
  minDelta?: number;
  color: string;
  view: 'fan' | 'orbit';
  thickness?: number;
  summary: string;
  size: string;
  discovery: string;
  basis: string;
  refs: { label: string; url: string }[];
  geometry: Geometry;
  status: 'visible' | 'outside';
  reason?: 'too-near' | 'too-far' | 'out-of-survey';
  coverage: number;
  galaxies: number;
  ratio?: number;
  center: Vec3;
  extent: number;
  distance: number;
}

export const MAX_HIGHLIGHTS = 8;

const ONE_PLUS_MIN = 0.05;
const ONE_PLUS_MAX = 10;
const Q_MAX = 254;
const RAD = Math.PI / 180;

/** The stored density value of a contrast, as `density.rs` encodes it. */
export function encodeDelta(delta: number): number {
  const v = Math.min(ONE_PLUS_MAX, Math.max(ONE_PLUS_MIN, delta + 1));
  return Math.round(((Math.log(v) - Math.log(ONE_PLUS_MIN)) / (Math.log(ONE_PLUS_MAX) - Math.log(ONE_PLUS_MIN))) * Q_MAX);
}

/** The vectors the point shader reads for one region. */
export interface RegionVectors {
  /** Sphere: centre and radius. Sky box: inward normal of the first meridian, and the near distance. */
  a: [number, number, number, number];
  /** Sky box: inward normal of the second meridian, and the far distance. */
  b: [number, number, number, number];
  /** Sky box: sin(dec) limits. The third value is the density limit in 0..1, or -1 for none. The fourth is 1 for a sky box. */
  c: [number, number, number, number];
}

export function regionVectors(g: Geometry, minDelta?: number): RegionVectors {
  const q = minDelta === undefined ? -1 : encodeDelta(minDelta) / 255;
  if (g.shape === 'sphere') {
    return { a: [g.center[0], g.center[1], g.center[2], g.radius], b: [0, 0, 0, 0], c: [0, 0, q, 0] };
  }
  const a0 = g.ra[0] * RAD;
  const a1 = g.ra[1] * RAD;
  return {
    a: [-Math.sin(a0), Math.cos(a0), 0, g.r[0]],
    b: [Math.sin(a1), -Math.cos(a1), 0, g.r[1]],
    c: [Math.sin(g.dec[0] * RAD), Math.sin(g.dec[1] * RAD), q, 1],
  };
}

/** The shader's region test, written out so it can be checked against the CLI. */
export function inRegion(v: RegionVectors, p: Vec3): boolean {
  const d = Math.hypot(p[0], p[1], p[2]);
  if (v.c[3] < 0.5) return Math.hypot(p[0] - v.a[0], p[1] - v.a[1], p[2] - v.a[2]) <= v.a[3];
  return (
    d >= v.a[3] &&
    d <= v.b[3] &&
    v.a[0] * p[0] + v.a[1] * p[1] >= 0 &&
    v.b[0] * p[0] + v.b[1] * p[1] >= 0 &&
    p[2] >= d * v.c[0] &&
    p[2] <= d * v.c[1]
  );
}

/** True when a cube can hold galaxies of the region. */
export function cubeTouches(center: Vec3, half: number, target: Vec3, radius: number): boolean {
  let sum = 0;
  for (let a = 0; a < 3; a++) {
    const d = Math.max(0, Math.abs(center[a] - target[a]) - half);
    sum += d * d;
  }
  return sum <= radius * radius;
}

/** Reads `s=a,b` from a location hash. Null when the hash does not say. */
export function decodeStructureIds(hash: string): string[] | null {
  const m = /[#&]s=([^&]*)/.exec(hash);
  if (!m) return null;
  return m[1].split(',').filter((id) => /^[a-z0-9-]+$/.test(id));
}

/** Mpc/h to 億光年, at h = 0.7. */
export function okuLightYears(mpc: number): number {
  return mpc * 0.0466;
}
