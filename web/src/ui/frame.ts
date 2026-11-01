import type { Metadata } from '../data/types';
import { sky, type Vec3 } from '../math';

const OM = 0.31;
const OL = 0.69;
const C_OVER_H0 = 2997.92458;

/** Redshift at a comoving distance in Mpc/h, by numeric integration. */
export function redshiftAt(r: number): number {
  const step = 0.0005;
  let z = 0;
  let acc = 0;
  let prev = 1;
  while (acc < r && z < 3) {
    z += step;
    const inv = 1 / Math.sqrt(OM * (1 + z) ** 3 + OL);
    acc += 0.5 * (prev + inv) * step * C_OVER_H0;
    prev = inv;
  }
  return z;
}

export interface Tick { p: Vec3; t: string }

/** U6: the survey outline and distance ticks. Returns line segments and labels. */
export function buildFrame(meta: Metadata): { lines: number[]; ticks: Tick[] } {
  const lines: number[] = [];
  const ticks: Tick[] = [];
  const segment = (f: (t: number) => Vec3, n: number) => {
    let prev = f(0);
    for (let i = 1; i <= n; i++) {
      const p = f(i / n);
      lines.push(...prev, ...p);
      prev = p;
    }
  };
  const rMax = meta.rRange[1];
  const step = rMax > 800 ? 200 : 100;
  const label = (r: number) => `${r} Mpc/h · z≈${redshiftAt(r).toFixed(3)}`;
  const fp = meta.footprint;

  if (fp && !fp.fullSky) {
    const [a0, a1Raw] = fp.raRange;
    const a1 = a1Raw < a0 ? a1Raw + 360 : a1Raw;
    const [d0, d1] = fp.decRange;
    segment((t) => sky(rMax, a0 + (a1 - a0) * t, d0), 48);
    segment((t) => sky(rMax, a0 + (a1 - a0) * t, d1), 48);
    segment((t) => sky(rMax, a0, d0 + (d1 - d0) * t), 24);
    segment((t) => sky(rMax, a1, d0 + (d1 - d0) * t), 24);
    for (const [a, d] of [[a0, d0], [a1, d0], [a0, d1], [a1, d1]]) lines.push(0, 0, 0, ...sky(rMax, a, d));
    for (let r = step; r < rMax; r += step) {
      segment((t) => sky(r, a0 + (a1 - a0) * t, d0), 40);
      ticks.push({ p: sky(r, a1, d0), t: label(r) });
    }
  } else {
    for (let r = step; r < rMax; r += step) {
      segment((t) => sky(r, 360 * t, 0), 90);
      ticks.push({ p: sky(r, 0, 0), t: label(r) });
    }
  }
  return { lines, ticks };
}

/** Three great circles at the void's radius (U3). */
export function sphereLines(c: [number, number, number], radius: number): number[] {
  const out: number[] = [];
  const N = 72;
  for (let axis = 0; axis < 3; axis++) {
    const at = (t: number): Vec3 => {
      const a = Math.cos(t) * radius;
      const b = Math.sin(t) * radius;
      if (axis === 0) return [c[0] + a, c[1] + b, c[2]];
      if (axis === 1) return [c[0] + a, c[1], c[2] + b];
      return [c[0], c[1] + a, c[2] + b];
    };
    for (let k = 0; k < N; k++) out.push(...at((k / N) * 2 * Math.PI), ...at(((k + 1) / N) * 2 * Math.PI));
  }
  return out;
}

/** U7: picks a round length for the scale bar. Mpc/h to light years at h=0.7. */
export function scaleBar(mpcPerPixel: number): { px: number; text: string } {
  let length = 1;
  for (const n of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
    if (n / mpcPerPixel <= 130) length = n;
  }
  const oku = length * 0.0466;
  const ly = oku < 1 ? `${Math.round(length * 466)}万光年` : `${oku.toFixed(1)}億光年`;
  return { px: Math.round(length / mpcPerPixel), text: `${length} Mpc/h ≈ ${ly}` };
}
