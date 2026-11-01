import type { Hierarchy } from '../data/hierarchy';
import type { Plane, Vec3 } from '../math';

const SQRT3 = Math.sqrt(3);
/** Children smaller than this on screen are not refined. */
const MIN_CHILD_PX = 70;
const MIN_DISTANCE = 0.5;

/** A max-heap of node ids ordered by screen size. */
class NodeHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] >= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop()!;
    const key = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] > keys[c]) c++;
        if (keys[c] <= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

export interface Slab {
  normal: Vec3;
  center: Vec3;
  thickness: number;
}

export interface SelectInput {
  hierarchy: Hierarchy;
  eye: Vec3;
  /** Screen height in px over 2 tan(fov/2). */
  projection: number;
  planes: Plane[];
  budget: number;
  slab: Slab | null;
  isLoaded(id: number): boolean;
}

export interface Selection {
  visible: number[];
  /** Nodes to fetch, most important first. */
  want: number[];
  points: number;
}

/**
 * Walks the tree from the root, largest on screen first. A node that is not loaded yet
 * is requested and its children wait, so detail arrives from coarse to fine.
 */
export function selectNodes(input: SelectInput): Selection {
  const { hierarchy: h, eye, projection, planes, budget, slab } = input;
  const out: Selection = { visible: [], want: [], points: 0 };
  if (budget <= 0 || h.count === 0) return out;

  const heap = new NodeHeap();
  heap.push(0, Infinity);
  while (heap.size > 0) {
    const id = heap.pop();
    const cx = h.cx(id);
    const cy = h.cy(id);
    const cz = h.cz(id);
    const radius = h.half(id) * SQRT3;

    let inside = true;
    for (const p of planes) {
      if (p[0] * cx + p[1] * cy + p[2] * cz + p[3] < -radius) {
        inside = false;
        break;
      }
    }
    if (!inside) continue;
    if (slab) {
      const d = (cx - slab.center[0]) * slab.normal[0] + (cy - slab.center[1]) * slab.normal[1] + (cz - slab.center[2]) * slab.normal[2];
      if (Math.abs(d) > slab.thickness / 2 + radius) continue;
    }

    const count = h.points(id);
    if (out.points + count > budget && out.points > 0) break;
    if (!input.isLoaded(id)) {
      out.want.push(id);
      continue;
    }
    out.visible.push(id);
    out.points += count;

    const mask = h.childMask(id);
    let child = h.firstChild(id);
    for (let o = 0; o < 8; o++) {
      if (!((mask >> o) & 1)) continue;
      const r = h.half(child) * SQRT3;
      const dist = Math.hypot(h.cx(child) - eye[0], h.cy(child) - eye[1], h.cz(child) - eye[2]);
      const px = (r / Math.max(dist - r, MIN_DISTANCE)) * projection;
      if (px > MIN_CHILD_PX) heap.push(child, px);
      child++;
    }
  }
  return out;
}
