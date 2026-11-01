import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeHash, encodeHash } from '../src/camera/camera';
import { Hierarchy } from '../src/data/hierarchy';
import { cubeTouches, decodeStructureIds, encodeDelta, inRegion, regionVectors, type Structure } from '../src/data/structures';
import type { Metadata } from '../src/data/types';
import { sky, type Vec3 } from '../src/math';

const dir = new URL('./fixtures/regions/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir));
const buf = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('regions', () => {
  it('a sky box across RA 0 holds what it should', () => {
    const v = regionVectors({ shape: 'sky-box', ra: [350, 10], dec: [-5, 5], r: [90, 110] });
    expect(inRegion(v, sky(100, 355, 0))).toBe(true);
    expect(inRegion(v, sky(100, 5, 0))).toBe(true);
    expect(inRegion(v, sky(100, 20, 0))).toBe(false);
    expect(inRegion(v, sky(100, 180, 0))).toBe(false);
    expect(inRegion(v, sky(100, 355, 7))).toBe(false);
    expect(inRegion(v, sky(120, 355, 0))).toBe(false);
  });

  it('a sphere holds what it should', () => {
    const v = regionVectors({ shape: 'sphere', center: [10, 0, 0], radius: 5 });
    expect(inRegion(v, [14, 0, 0])).toBe(true);
    expect(inRegion(v, [16, 0, 0])).toBe(false);
  });

  it('counts the same galaxies as the CLI', () => {
    const meta = JSON.parse(read('metadata.json').toString()) as Metadata;
    const layer = meta.layers.find((l) => l.kind === 'regions')!;
    const list = JSON.parse(read(layer.file).toString()) as Structure[];
    const h = new Hierarchy(buf(read('hierarchy.bin')));
    const q = new Int16Array(buf(read('points.bin')));
    const visible = list.filter((s) => s.status === 'visible');
    expect(visible.length).toBeGreaterThan(5);
    const counts = new Map(visible.map((s) => [s.id, 0]));
    const vectors = visible.map((s) => [s.id, regionVectors(s.geometry)] as const);
    let at = 0;
    for (let id = 0; id < h.count; id++) {
      for (let i = 0; i < h.points(id); i++, at++) {
        const p: Vec3 = [h.cx(id) + (q[at * 4] / 32767) * h.half(id), h.cy(id) + (q[at * 4 + 1] / 32767) * h.half(id), h.cz(id) + (q[at * 4 + 2] / 32767) * h.half(id)];
        for (const [sid, v] of vectors) if (inRegion(v, p)) counts.set(sid, counts.get(sid)! + 1);
      }
    }
    // Stored positions are rounded to 3 decimals, so galaxies right on an edge may differ.
    for (const s of visible) expect(Math.abs(counts.get(s.id)! - s.galaxies)).toBeLessThanOrEqual(3);
  });

  it('marks the structures out of reach with their reason', () => {
    const list = JSON.parse(read('structures.json').toString()) as Structure[];
    expect(list.find((s) => s.id === 'away')?.reason).toBe('out-of-survey');
    expect(list.find((s) => s.id === 'deep')?.reason).toBe('too-far');
    expect(list.find((s) => s.id === 's1')?.status).toBe('visible');
  });

  it('encodes a density contrast like the writer', () => {
    expect(encodeDelta(-1)).toBe(0);
    expect(encodeDelta(100)).toBe(254);
    // One plus delta of 1: log(1 / 0.05) / log(10 / 0.05) of the scale.
    expect(encodeDelta(0)).toBe(144);
  });

  it('finds the tiles a region touches', () => {
    expect(cubeTouches([0, 0, 0], 10, [15, 0, 0], 6)).toBe(true);
    expect(cubeTouches([0, 0, 0], 10, [15, 0, 0], 4)).toBe(false);
  });
});

describe('location hash', () => {
  const view = { target: [1, 2, 3] as Vec3, yaw: 0.5, pitch: 0.25, dist: 100 };

  it('round-trips the view and the structures', () => {
    const hash = encodeHash(view, ['sgw', 'coma-sc']);
    expect(hash).toBe('#v=1,2,3,0.5,0.25,100&s=sgw,coma-sc');
    expect(decodeHash(hash)).toEqual(view);
    expect(decodeStructureIds(hash)).toEqual(['sgw', 'coma-sc']);
  });

  it('leaves structures out of a URL when none are on', () => {
    const hash = encodeHash(view);
    expect(hash).toBe('#v=1,2,3,0.5,0.25,100');
    expect(decodeStructureIds(hash)).toBeNull();
  });

  it('works without a view, and drops malformed ids', () => {
    expect(decodeHash('#s=sgw')).toBeNull();
    expect(decodeStructureIds('#s=sgw,<b>,coma')).toEqual(['sgw', 'coma']);
  });
});
