import { V, type Vec3 } from '../math';

export const FLY_MS = 1400;
const MIN_DIST = 0.8;
const PITCH_LIMIT = 1.52;

export interface CameraState {
  target: Vec3;
  yaw: number;
  pitch: number;
  dist: number;
}

/** Orbit camera around a target, with z (declination) up. */
export class Camera implements CameraState {
  target: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0.9;
  dist = 800;
  readonly fov = (50 * Math.PI) / 180;
  maxDist = 4000;
  private fly: { t0: number; a: CameraState; b: CameraState } | null = null;

  get flying() {
    return this.fly !== null;
  }

  eye(): Vec3 {
    const cp = Math.cos(this.pitch);
    return V.add(this.target, V.sc([cp * Math.cos(this.yaw), cp * Math.sin(this.yaw), Math.sin(this.pitch)], this.dist));
  }

  set(s: CameraState) {
    this.target = [...s.target] as Vec3;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.dist = s.dist;
    this.fly = null;
  }

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dy * 0.005));
  }

  pan(dx: number, dy: number, viewHeight: number) {
    const f = V.norm(V.sub(this.target, this.eye()));
    const r = V.norm(V.cross(f, [0, 0, 1]));
    const u = V.cross(r, f);
    const k = (2 * this.dist * Math.tan(this.fov / 2)) / viewHeight;
    this.target = V.add(this.target, V.add(V.sc(r, -dx * k), V.sc(u, dy * k)));
  }

  zoom(factor: number) {
    this.dist = Math.min(this.maxDist, Math.max(MIN_DIST, this.dist * factor));
  }

  flyTo(target: Vec3, dist: number, yaw: number, pitch: number, now: number) {
    const dy = (((yaw - this.yaw) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.fly = {
      t0: now,
      a: { target: [...this.target] as Vec3, dist: this.dist, yaw: this.yaw, pitch: this.pitch },
      b: { target, dist, yaw: this.yaw + dy, pitch },
    };
  }

  stopFlying() {
    this.fly = null;
  }

  /** Advances a flight. Returns true while the camera moved. */
  step(now: number): boolean {
    if (!this.fly) return false;
    const { t0, a, b } = this.fly;
    const t = Math.min(1, (now - t0) / FLY_MS);
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.target = V.lerp(a.target, b.target, k);
    this.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * k);
    this.yaw = a.yaw + (b.yaw - a.yaw) * k;
    this.pitch = a.pitch + (b.pitch - a.pitch) * k;
    if (t >= 1) this.fly = null;
    return true;
  }
}

/** `#v=x,y,z,yaw,pitch,dist`, so a view can be shared by URL. */
export function encodeHash(s: CameraState): string {
  const n = (v: number, d: number) => +v.toFixed(d);
  return `#v=${n(s.target[0], 2)},${n(s.target[1], 2)},${n(s.target[2], 2)},${n(s.yaw, 4)},${n(s.pitch, 4)},${n(s.dist, 2)}`;
}

export function decodeHash(hash: string): CameraState | null {
  const m = /^#v=([^&]+)$/.exec(hash);
  if (!m) return null;
  const p = m[1].split(',').map(Number);
  if (p.length !== 6 || p.some((v) => !Number.isFinite(v)) || p[5] <= 0) return null;
  return { target: [p[0], p[1], p[2]], yaw: p[3], pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p[4])), dist: p[5] };
}
