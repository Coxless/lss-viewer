/**
 * Which tiles are on the GPU, in least-recently-used order. Holds `used` frame numbers
 * only; the GPU objects stay with the renderer through the `release` callback.
 */
export class TileCache<T> {
  private readonly entries = new Map<number, { value: T; points: number; used: number }>();
  points = 0;

  constructor(private readonly release: (value: T) => void) {}

  get size() {
    return this.entries.size;
  }

  has(id: number) {
    return this.entries.has(id);
  }

  get(id: number): T | undefined {
    return this.entries.get(id)?.value;
  }

  touch(id: number, frame: number) {
    const e = this.entries.get(id);
    if (e) e.used = frame;
  }

  add(id: number, value: T, points: number, frame: number) {
    this.entries.set(id, { value, points, used: frame });
    this.points += points;
  }

  /**
   * Over `capacity` points, drops the least recently used tiles down to 85% of it. The
   * root stays, and so do tiles used in the current frame.
   */
  evict(capacity: number, frame: number): number {
    if (this.points <= capacity) return 0;
    const old = [...this.entries.entries()]
      .filter(([id, e]) => id !== 0 && e.used < frame)
      .sort((a, b) => a[1].used - b[1].used);
    let dropped = 0;
    for (const [id, e] of old) {
      if (this.points <= capacity * 0.85) break;
      this.release(e.value);
      this.entries.delete(id);
      this.points -= e.points;
      dropped++;
    }
    return dropped;
  }

  clear() {
    for (const e of this.entries.values()) this.release(e.value);
    this.entries.clear();
    this.points = 0;
  }
}
