import type { Camera, CameraState } from '../camera/camera';
import type { Vec3 } from '../math';

export interface BenchResult {
  seconds: number;
  frames: number;
  fps: number;
  /** Frames-per-second of the slowest 5% of frames. */
  fpsLow: number;
  avgPoints: number;
  maxPoints: number;
  transferredMB: number;
  gpuMB: number;
  budget: number;
  viewport: [number, number];
  dpr: number;
}

/** A fixed path: orbit far away, fly in, orbit close to the data, fly back out. */
export function benchPose(t: number, center: Vec3, ext: number): CameraState {
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  const s = (k: number) => k * k * (3 - 2 * k);
  const dist = t < 0.3 ? ext * 1.25 : t < 0.5 ? lerp(ext * 1.25, ext * 0.25, s((t - 0.3) / 0.2)) : t < 0.8 ? ext * 0.25 : lerp(ext * 0.25, ext * 1.25, s((t - 0.8) / 0.2));
  return { target: center, yaw: t * 2 * Math.PI * 1.5, pitch: 0.5 + 0.3 * Math.sin(t * 6.28), dist };
}

export function runBench(opts: {
  camera: Camera;
  center: Vec3;
  ext: number;
  seconds: number;
  markDirty: () => void;
  stats: () => { points: number; transferred: number; gpuBytes: number; budget: number; width: number; height: number; dpr: number };
}): Promise<BenchResult> {
  const { camera, center, ext, seconds, markDirty, stats } = opts;
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let sumPoints = 0;
    let maxPoints = 0;
    let t0 = -1;
    let last = -1;
    const tick = (now: number) => {
      if (t0 < 0) {
        t0 = now;
        last = now;
      }
      const elapsed = (now - t0) / 1000;
      if (now !== last) intervals.push(now - last);
      last = now;
      const s = stats();
      sumPoints += s.points;
      maxPoints = Math.max(maxPoints, s.points);
      if (elapsed >= seconds) {
        const sorted = [...intervals].sort((a, b) => b - a);
        const worst = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));
        const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
        resolve({
          seconds,
          frames: intervals.length,
          fps: +(1000 / mean(intervals)).toFixed(1),
          fpsLow: +(1000 / mean(worst)).toFixed(1),
          avgPoints: Math.round(sumPoints / Math.max(1, intervals.length)),
          maxPoints,
          transferredMB: +(s.transferred / 1048576).toFixed(2),
          gpuMB: +(s.gpuBytes / 1048576).toFixed(1),
          budget: s.budget,
          viewport: [s.width, s.height],
          dpr: s.dpr,
        });
        return;
      }
      camera.set(benchPose(elapsed / seconds, center, ext));
      markDirty();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
