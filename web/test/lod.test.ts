import { describe, expect, it } from 'vitest';
import { encodeHash, decodeHash } from '../src/camera/camera';
import { Hierarchy } from '../src/data/hierarchy';
import { TileCache } from '../src/lod/cache';
import { selectNodes, type SelectInput } from '../src/lod/select';
import { frustumPlanes, lookAt, multiply, perspective, type Vec3 } from '../src/math';
import { redshiftAt, scaleBar } from '../src/ui/frame';

/** A root with eight children, each with `count` points. */
function tree(count: number): Hierarchy {
  const buf = new ArrayBuffer(32 * 9);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  const b = new Uint8Array(buf);
  f[3] = 100;
  u[5] = count;
  b[24] = 0xff;
  u[7] = 1;
  for (let o = 0; o < 8; o++) {
    const i = o + 1;
    f[i * 8] = o & 1 ? 50 : -50;
    f[i * 8 + 1] = o & 2 ? 50 : -50;
    f[i * 8 + 2] = o & 4 ? 50 : -50;
    f[i * 8 + 3] = 50;
    u[i * 8 + 5] = count;
    b[i * 32 + 25] = 1;
  }
  return new Hierarchy(buf);
}

function view(eye: Vec3, target: Vec3 = [0, 0, 0]) {
  const vp = multiply(perspective(0.87, 1, 1, 5000), lookAt(eye, target, [0, 0, 1]));
  return { eye, projection: 800 / (2 * Math.tan(0.435)), planes: frustumPlanes(vp) };
}

const input = (over: Partial<SelectInput>): SelectInput => ({
  hierarchy: tree(100),
  ...view([0, -300, 0]),
  budget: 1e6,
  slab: null,
  isLoaded: () => true,
  ...over,
});

describe('selectNodes', () => {
  it('asks for the root first and does not refine past a missing node', () => {
    const s = selectNodes(input({ isLoaded: () => false }));
    expect(s.want).toEqual([0]);
    expect(s.visible).toEqual([]);
  });

  it('visits nodes largest on screen first', () => {
    const s = selectNodes(input({}));
    expect(s.visible[0]).toBe(0);
    expect(s.visible.length).toBe(9);
    const h = tree(100);
    // Children on the y<0 side are closer to an eye at y=-300.
    const firstChild = s.visible[1];
    expect(h.cy(firstChild)).toBeLessThan(0);
    expect(s.points).toBe(900);
  });

  it('stops at the point budget', () => {
    const s = selectNodes(input({ budget: 350 }));
    expect(s.points).toBeLessThanOrEqual(350);
    expect(s.visible.length).toBe(3);
  });

  it('selects nothing with no budget', () => {
    expect(selectNodes(input({ budget: 0 })).visible).toEqual([]);
  });

  it('skips nodes outside the view', () => {
    // Looking straight down the -y axis from close by, with a narrow target: rear octants drop.
    const near = view([0, -60, 0], [0, -500, 0]);
    const s = selectNodes(input({ ...near }));
    const h = tree(100);
    expect(s.visible.length).toBeGreaterThan(0);
    for (const id of s.visible.slice(1)) expect(h.cy(id)).toBeLessThan(0);
  });

  it('skips nodes that miss the slab', () => {
    const s = selectNodes(input({ slab: { normal: [1, 0, 0], center: [95, 0, 0], thickness: 4 } }));
    const h = tree(100);
    for (const id of s.visible.slice(1)) expect(h.cx(id)).toBeGreaterThan(-60);
  });

  it('does not refine a child that is tiny on screen', () => {
    const far = view([0, -60000, 0]);
    expect(selectNodes(input({ ...far, planes: [] })).visible).toEqual([0]);
  });
});

describe('TileCache', () => {
  it('drops the oldest tiles but keeps the root and the current frame', () => {
    const released: number[] = [];
    const c = new TileCache<number>((v) => released.push(v));
    c.add(0, 100, 100, 1);
    c.add(1, 101, 100, 2);
    c.add(2, 102, 100, 3);
    c.add(3, 103, 100, 10);
    c.evict(250, 10);
    expect(released).toEqual([101, 102]);
    expect(c.has(0)).toBe(true);
    expect(c.has(3)).toBe(true);
    expect(c.points).toBe(200);
  });

  it('touching protects a tile', () => {
    const released: number[] = [];
    const c = new TileCache<number>((v) => released.push(v));
    c.add(1, 1, 100, 1);
    c.add(2, 2, 100, 2);
    c.touch(1, 5);
    c.evict(150, 6);
    expect(released).toEqual([2]);
  });

  it('does nothing under capacity, and clear releases everything', () => {
    const released: number[] = [];
    const c = new TileCache<number>((v) => released.push(v));
    c.add(0, 7, 100, 1);
    expect(c.evict(100, 2)).toBe(0);
    c.clear();
    expect(released).toEqual([7]);
    expect(c.points).toBe(0);
  });
});

describe('view hash', () => {
  it('round trips', () => {
    const s = { target: [1.5, -2.25, 3] as Vec3, yaw: 1.2345, pitch: -0.5, dist: 120.5 };
    expect(decodeHash(encodeHash(s))).toEqual(s);
  });

  it('rejects junk', () => {
    expect(decodeHash('')).toBeNull();
    expect(decodeHash('#v=1,2,3')).toBeNull();
    expect(decodeHash('#v=a,b,c,d,e,f')).toBeNull();
    expect(decodeHash('#v=0,0,0,0,0,-5')).toBeNull();
  });
});

describe('labels', () => {
  it('converts distance to redshift', () => {
    expect(redshiftAt(292.7)).toBeCloseTo(0.1, 2);
  });

  it('scale bar picks a round length', () => {
    const s = scaleBar(1);
    expect(s.text).toBe('100 Mpc/h ≈ 4.7億光年');
    expect(s.px).toBe(100);
    expect(scaleBar(0.1).text).toBe('10 Mpc/h ≈ 4660万光年');
  });
});
