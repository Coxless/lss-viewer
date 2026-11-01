import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Hierarchy } from '../src/data/hierarchy';
import { decodeShells } from '../src/data/shells';
import type { Metadata, VoidEntry } from '../src/data/types';

// These read a dataset written by lss-viewer-cli (`npm run fixtures`), so the Rust writer and
// the TypeScript readers are checked against each other.
const dir = new URL('./fixtures/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir));
const buf = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const meta = JSON.parse(read('metadata.json').toString()) as Metadata;

describe('dataset written by the CLI', () => {
  it('has the documented metadata', () => {
    expect(meta.format).toBe('lss-viewer/1');
    expect(meta.octree.pointBytes).toBe(8);
    expect(meta.layers.map((l) => l.kind)).toEqual(['isosurface', 'list']);
    expect(meta.source.mock).toBe(true);
    expect(meta.density?.encoding).toBe('uint8-log');
  });

  it('hierarchy: every point is covered exactly once and children are consistent', () => {
    const h = new Hierarchy(buf(read('hierarchy.bin')));
    expect(h.count).toBe(meta.octree.nodes);
    let points = 0;
    let offset = 0;
    for (let i = 0; i < h.count; i++) {
      points += h.points(i);
      expect(h.byteOffset(i)).toBe(offset);
      offset += h.points(i) * 8;
      if (h.childMask(i)) {
        expect(h.firstChild(i)).toBeGreaterThan(i);
        expect(h.depth(h.firstChild(i))).toBe(h.depth(i) + 1);
      }
    }
    expect(points).toBe(meta.octree.points);
    expect(read('points.bin').length).toBe(points * 8);
  });

  it('points decode inside the survey volume', () => {
    const h = new Hierarchy(buf(read('hierarchy.bin')));
    const q = new Int16Array(buf(read('points.bin')));
    const [lo, hi] = [meta.bbox.slice(0, 3), meta.bbox.slice(3)];
    for (let i = 0; i < h.points(0); i++) {
      const x = h.cx(0) + (q[i * 4] / 32767) * h.half(0);
      const y = h.cy(0) + (q[i * 4 + 1] / 32767) * h.half(0);
      const z = h.cz(0) + (q[i * 4 + 2] / 32767) * h.half(0);
      const eps = h.half(0) / 1000;
      expect(x).toBeGreaterThan(lo[0] - eps);
      expect(x).toBeLessThan(hi[0] + eps);
      expect(y).toBeGreaterThan(lo[1] - eps);
      expect(y).toBeLessThan(hi[1] + eps);
      expect(z).toBeGreaterThan(lo[2] - eps);
      expect(z).toBeLessThan(hi[2] + eps);
      expect(q[i * 4 + 3]).toBeGreaterThanOrEqual(0);
    }
  });

  it('shells: decoded counts match the metadata and indices are in range', () => {
    const layer = meta.layers[0];
    const mesh = decodeShells(buf(gunzipSync(read(layer.file))));
    const vertices = mesh.vertices.byteLength / 8;
    expect(vertices).toBe(layer.params.vertices);
    expect(mesh.indices.length).toBe(layer.params.indices);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.reduce((a, b) => Math.max(a, b), 0)).toBe(vertices - 1);
    expect(mesh.indices.reduce((a, b) => Math.min(a, b), vertices)).toBe(0);
    expect(mesh.threshold).toBeCloseTo(-0.6, 5);
  });

  it('density: the file has one byte per cell', () => {
    const info = meta.density!;
    const q = gunzipSync(read(info.file));
    expect(q.length).toBe(info.dims[0] * info.dims[1] * info.dims[2]);
    expect(q.includes(255)).toBe(true);
    expect(q.some((v) => v !== 255)).toBe(true);
  });

  it('voids: a list sorted by size', () => {
    const v = JSON.parse(read('voids.json').toString()) as VoidEntry[];
    expect(v.length).toBeGreaterThan(0);
    for (let i = 1; i < v.length; i++) expect(v[i].radius).toBeLessThanOrEqual(v[i - 1].radius);
    expect(v[0].method).toBe('simple');
  });
});

it('rejects a file that is not a shell mesh', () => {
  expect(() => decodeShells(new ArrayBuffer(64))).toThrow();
});
